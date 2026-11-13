import { apiTokens, deviceAuthorizations, memberships, tenants } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import type { ApiToken, Membership, Tenant, TokenScope } from "@weave-order/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { toIso, toIsoOrNull } from "./mappers";
import { mapMembership, mapTenant } from "./tenancy.service";

/**
 * 个人访问凭据的确定性内核（WAN-78）。
 *
 * 这是 api_tokens / device_authorizations 两张表的唯一写入者：
 * - 明文 token 永远不进入本层，本层只收 `publicId` 与 `tokenHash`；
 * - 签发 / 撤销写审计，tenantId 取凭据所属 member 的租户；
 * - 设备登录的确认 / 消费都是条件更新，并发下不会重复发 token。
 *
 * 表本身不带 tenant_id（控制面）；认证后由网关解析 membership → tenant，
 * 业务请求仍走 RLS 会话，不存在绕过租户隔离的旁路。
 */

type TokenRow = typeof apiTokens.$inferSelect;
type DeviceRow = typeof deviceAuthorizations.$inferSelect;
type MembershipRow = typeof memberships.$inferSelect;

export interface CreateTokenRecord {
  membershipId: string;
  tenantId: string;
  name: string;
  publicId: string;
  tokenHash: string;
  scopes: TokenScope[];
  expiresAt: Date | null;
  /** 审计中的操作者，如 `oidc:<sub>` 或 `user:<membershipId>`。 */
  actorId: string;
}

export interface DeviceAuthorizationRecord {
  deviceCodeHash: string;
  userCode: string;
  clientName: string | null;
  expiresAt: Date;
  intervalSeconds: number;
}

function actorContext(actorId: string): KernelContext {
  return { actor: { type: "HUMAN", id: actorId } };
}

export function tokenStatus(row: TokenRow, now: Date = new Date()): ApiToken["status"] {
  if (row.revokedAt) return "REVOKED";
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "ACTIVE";
}

function mapToken(row: TokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    prefix: `wo_${row.publicId}`,
    scopes: row.scopes as TokenScope[],
    status: tokenStatus(row),
    createdAt: toIso(row.createdAt),
    lastUsedAt: toIsoOrNull(row.lastUsedAt),
    expiresAt: toIsoOrNull(row.expiresAt),
    revokedAt: toIsoOrNull(row.revokedAt),
  };
}

export class AccessService {
  constructor(private readonly db: Db) {}

  /** 签发 token（明文哈希由调用方算好）。 */
  async createToken(record: CreateTokenRecord): Promise<ApiToken> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(apiTokens)
        .values({
          membershipId: record.membershipId,
          name: record.name,
          publicId: record.publicId,
          tokenHash: record.tokenHash,
          scopes: record.scopes,
          expiresAt: record.expiresAt,
        })
        .returning();
      if (!row) throw new Error("token 写入失败");
      await appendAudit(
        tx,
        actorContext(record.actorId),
        {
          action: "API_TOKEN_CREATED",
          entityType: "api_token",
          entityId: row.id,
          after: { name: row.name, scopes: row.scopes, prefix: `wo_${row.publicId}` },
        },
        record.tenantId,
      );
      return mapToken(row);
    });
  }

  async listTokens(membershipId: string): Promise<ApiToken[]> {
    const rows = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.membershipId, membershipId))
      .orderBy(desc(apiTokens.createdAt));
    return rows.map(mapToken);
  }

  /** 撤销 token：只允许撤销自己的，幂等。 */
  async revokeToken(input: {
    membershipId: string;
    tenantId: string;
    tokenId: string;
    actorId: string;
  }): Promise<ApiToken | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiTokens.id, input.tokenId),
            eq(apiTokens.membershipId, input.membershipId),
            isNull(apiTokens.revokedAt),
          ),
        )
        .returning();
      if (!row) {
        const [existing] = await tx
          .select()
          .from(apiTokens)
          .where(
            and(eq(apiTokens.id, input.tokenId), eq(apiTokens.membershipId, input.membershipId)),
          )
          .limit(1);
        return existing ? mapToken(existing) : null;
      }
      await appendAudit(
        tx,
        actorContext(input.actorId),
        {
          action: "API_TOKEN_REVOKED",
          entityType: "api_token",
          entityId: row.id,
          before: { revokedAt: null },
          after: { revokedAt: toIso(row.revokedAt ?? new Date()) },
        },
        input.tenantId,
      );
      return mapToken(row);
    });
  }

  /** 按 publicId 取 token + 所属 membership / 租户（认证入口）。 */
  async findTokenByPublicId(publicId: string): Promise<{
    token: ApiToken;
    tokenHash: string;
    membershipId: string;
    membership: Membership;
    tenant: Tenant;
  } | null> {
    const rows = await this.db
      .select({ token: apiTokens, membership: memberships, tenant: tenants })
      .from(apiTokens)
      .innerJoin(memberships, eq(apiTokens.membershipId, memberships.id))
      .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
      .where(eq(apiTokens.publicId, publicId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      token: mapToken(row.token),
      tokenHash: row.token.tokenHash,
      membershipId: row.token.membershipId,
      membership: mapMembership(row.membership),
      tenant: mapTenant(row.tenant),
    };
  }

  /** 记录最近一次使用；一分钟内只写一次，失败不影响请求。 */
  async touchToken(tokenId: string): Promise<void> {
    try {
      await this.db
        .update(apiTokens)
        .set({ lastUsedAt: new Date() })
        .where(
          and(
            eq(apiTokens.id, tokenId),
            sql`(${apiTokens.lastUsedAt} is null or ${apiTokens.lastUsedAt} < now() - interval '1 minute')`,
          ),
        );
    } catch {
      // 只用于展示「最近使用」，写失败不应让已经合法的请求失败。
    }
  }

  /** CLI 自述需要的 membership + tenant（不落库，只读）。 */
  async getMembershipContext(
    membershipId: string,
  ): Promise<{ membership: Membership; tenant: Tenant } | null> {
    const rows = await this.db
      .select({ membership: memberships, tenant: tenants })
      .from(memberships)
      .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
      .where(eq(memberships.id, membershipId))
      .limit(1);
    const row = rows[0];
    return row
      ? { membership: mapMembership(row.membership), tenant: mapTenant(row.tenant) }
      : null;
  }

  async createDeviceAuthorization(record: DeviceAuthorizationRecord): Promise<void> {
    await this.db.insert(deviceAuthorizations).values({
      deviceCodeHash: record.deviceCodeHash,
      userCode: record.userCode,
      clientName: record.clientName,
      expiresAt: record.expiresAt,
      intervalSeconds: record.intervalSeconds,
    });
  }

  async findDeviceByCodeHash(hash: string): Promise<DeviceRow | null> {
    const [row] = await this.db
      .select()
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.deviceCodeHash, hash))
      .limit(1);
    return row ?? null;
  }

  async findDeviceByUserCode(userCode: string): Promise<DeviceRow | null> {
    const [row] = await this.db
      .select()
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.userCode, userCode))
      .limit(1);
    return row ?? null;
  }

  /** 人类确认 / 拒绝设备登录。只接受仍处于 PENDING 且未过期的授权。 */
  async decideDevice(input: {
    userCode: string;
    approve: boolean;
    membershipId: string | null;
    scopes: TokenScope[];
  }): Promise<DeviceRow | null> {
    const [row] = await this.db
      .update(deviceAuthorizations)
      .set({
        status: input.approve ? "APPROVED" : "DENIED",
        membershipId: input.membershipId,
        scopes: input.scopes,
        approvedAt: new Date(),
      })
      .where(
        and(
          eq(deviceAuthorizations.userCode, input.userCode),
          eq(deviceAuthorizations.status, "PENDING"),
          sql`${deviceAuthorizations.expiresAt} > now()`,
        ),
      )
      .returning();
    return row ?? null;
  }

  async markDevicePolled(id: string): Promise<void> {
    await this.db
      .update(deviceAuthorizations)
      .set({ lastPolledAt: new Date() })
      .where(eq(deviceAuthorizations.id, id));
  }

  /** 消费一条已批准的授权（一次性）。并发轮询只有一个能拿到行。 */
  async consumeDevice(deviceCodeHash: string): Promise<DeviceRow | null> {
    const [row] = await this.db
      .update(deviceAuthorizations)
      .set({ status: "CONSUMED", consumedAt: new Date() })
      .where(
        and(
          eq(deviceAuthorizations.deviceCodeHash, deviceCodeHash),
          eq(deviceAuthorizations.status, "APPROVED"),
        ),
      )
      .returning();
    return row ?? null;
  }
}

export type Access = AccessService;
export type { DeviceRow, MembershipRow };
