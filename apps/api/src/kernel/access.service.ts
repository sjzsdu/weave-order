import { apiTokens, deviceAuthorizations, users } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import type { ApiToken, TokenScope, WeaveUser } from "@weave-order/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { toIso, toIsoOrNull } from "./mappers";

/**
 * 账号与凭据的确定性内核（WAN-78）。
 *
 * 这是 users / api_tokens / device_authorizations 三张表的唯一写入者：
 * - token 的明文永远不进入本层，本层只收 `publicId` 与 `tokenHash`；
 * - 签发 / 撤销都写审计（HUMAN 上下文由调用方传入），
 *   因此「谁在什么时候给哪台机器发了凭据」可追溯；
 * - 设备登录的确认 / 消费都是条件更新（WHERE status = ...），并发下不会重复发 token。
 */

const SYSTEM_CTX: KernelContext = { actor: { type: "SYSTEM", id: "system:auth" } };

type UserRow = typeof users.$inferSelect;
type TokenRow = typeof apiTokens.$inferSelect;
type DeviceRow = typeof deviceAuthorizations.$inferSelect;

export interface CreateTokenRecord {
  userId: string;
  name: string;
  publicId: string;
  tokenHash: string;
  scopes: TokenScope[];
  expiresAt: Date | null;
  /** 审计中的操作者，如 `user:<uuid>`。 */
  actorId: string;
}

export interface DeviceAuthorizationRecord {
  deviceCodeHash: string;
  userCode: string;
  clientName: string | null;
  expiresAt: Date;
  intervalSeconds: number;
}

function mapUser(row: UserRow): WeaveUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: toIso(row.createdAt),
  };
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

  /** 按邮箱取账号；不存在则创建（MVP 的账号入口，接入 Casdoor 后改为 OIDC 映射）。 */
  async findOrCreateUser(input: { email: string; name?: string }): Promise<WeaveUser> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing[0]) return mapUser(existing[0]);

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(users)
        .values({ email, name: input.name?.trim() || email.split("@")[0] || email })
        .onConflictDoNothing({ target: users.email })
        .returning();
      const row = inserted[0];
      if (!row) {
        // 并发插入：另一个请求先建好了这个账号。
        const [found] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
        if (!found) throw new Error(`用户创建失败：${email}`);
        return mapUser(found);
      }
      await appendAudit(tx, SYSTEM_CTX, {
        action: "USER_CREATED",
        entityType: "user",
        entityId: row.id,
        after: { email: row.email },
      });
      return mapUser(row);
    });
  }

  /** 签发 token（明文哈希由调用方算好）。 */
  async createToken(record: CreateTokenRecord): Promise<ApiToken> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(apiTokens)
        .values({
          userId: record.userId,
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
        { actor: { type: "HUMAN", id: record.actorId } },
        {
          action: "API_TOKEN_CREATED",
          entityType: "api_token",
          entityId: row.id,
          after: { name: row.name, scopes: row.scopes, prefix: `wo_${row.publicId}` },
        },
      );
      return mapToken(row);
    });
  }

  async listTokens(userId: string): Promise<ApiToken[]> {
    const rows = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, userId))
      .orderBy(desc(apiTokens.createdAt));
    return rows.map(mapToken);
  }

  /** 撤销 token：只允许撤销自己的，幂等。 */
  async revokeToken(input: {
    userId: string;
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
            eq(apiTokens.userId, input.userId),
            isNull(apiTokens.revokedAt),
          ),
        )
        .returning();
      if (!row) {
        const [existing] = await tx
          .select()
          .from(apiTokens)
          .where(and(eq(apiTokens.id, input.tokenId), eq(apiTokens.userId, input.userId)))
          .limit(1);
        return existing ? mapToken(existing) : null;
      }
      await appendAudit(
        tx,
        { actor: { type: "HUMAN", id: input.actorId } },
        {
          action: "API_TOKEN_REVOKED",
          entityType: "api_token",
          entityId: row.id,
          before: { revokedAt: null },
          after: { revokedAt: toIso(row.revokedAt ?? new Date()) },
        },
      );
      return mapToken(row);
    });
  }

  /** 按 publicId 取 token + 所属账号（认证入口）。 */
  async findTokenByPublicId(
    publicId: string,
  ): Promise<{ token: ApiToken; tokenHash: string; user: WeaveUser } | null> {
    const rows = await this.db
      .select({ token: apiTokens, user: users })
      .from(apiTokens)
      .innerJoin(users, eq(apiTokens.userId, users.id))
      .where(eq(apiTokens.publicId, publicId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      token: mapToken(row.token),
      tokenHash: row.token.tokenHash,
      user: mapUser(row.user),
    };
  }

  /**
   * 记录最近一次使用；失败不影响请求（认证已完成）。
   * 一分钟内只写一次：避免每个请求都产生一次 UPDATE。
   */
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
    userId: string | null;
    scopes: TokenScope[];
  }): Promise<DeviceRow | null> {
    const [row] = await this.db
      .update(deviceAuthorizations)
      .set({
        status: input.approve ? "APPROVED" : "DENIED",
        userId: input.userId,
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

  /** 轮询时间戳：用于 slow_down 判定。 */
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

  async getUser(userId: string): Promise<WeaveUser | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return row ? mapUser(row) : null;
  }
}

export type Access = AccessService;
export { mapToken as toApiToken };
