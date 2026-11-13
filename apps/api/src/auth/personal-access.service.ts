import {
  CreateApiTokenInput,
  DeviceAuthorizationDecision,
  TOKEN_SCOPES,
} from "@weave-order/schema";
import type {
  ApiToken,
  CreatedApiToken,
  DeviceAuthorizationStart,
  Membership,
  PersonalAccessIdentity,
  Tenant,
  TokenScope,
} from "@weave-order/schema";
import type { AccessService } from "../kernel/access.service";
import { loadEnv } from "../platform/env";
import {
  generateApiToken,
  generateDeviceCode,
  generateUserCode,
  hashesEqual,
  hashSecret,
  hashToken,
  normalizeUserCode,
  parseApiToken,
} from "./crypto";
import { isUniqueViolation } from "../kernel/errors";
import { authError } from "./errors";

export interface VerifiedPersonalToken {
  token: ApiToken;
  membership: Membership;
  tenant: Tenant;
  scopes: TokenScope[];
}

function dedupeScopes(scopes: readonly TokenScope[]): TokenScope[] {
  return TOKEN_SCOPES.filter((scope) => scopes.includes(scope));
}

/**
 * 个人访问凭据的应用层：生成 / 校验 / 设备登录编排，不碰数据库。
 * 所有读写都经 kernel.access（唯一写入者，签发与撤销自动落审计）。
 */
export class PersonalAccessService {
  private readonly env = loadEnv();

  constructor(private readonly access: AccessService) {}

  private get pepper(): string {
    return this.env.PERSONAL_TOKEN_PEPPER;
  }

  private get webUrl(): string {
    return this.env.WEB_APP_URL.replace(/\/+$/, "");
  }

  /** 校验 `wo_...` 凭据；格式 / 哈希不匹配返回 null，状态异常抛 AuthError。 */
  async verify(rawToken: string): Promise<VerifiedPersonalToken | null> {
    const parsed = parseApiToken(rawToken);
    if (!parsed) return null;

    const found = await this.access.findTokenByPublicId(parsed.publicId);
    if (!found || !hashesEqual(found.tokenHash, hashToken(rawToken, this.pepper))) return null;
    if (found.token.status === "REVOKED") throw authError("TOKEN_REVOKED", "凭据已被撤销");
    if (found.token.status === "EXPIRED") throw authError("TOKEN_EXPIRED", "凭据已过期");
    if (found.membership.status !== "ACTIVE") {
      throw authError("INVALID_TOKEN", "凭据所属成员身份未启用");
    }

    void this.access.touchToken(found.token.id);
    return {
      token: found.token,
      membership: found.membership,
      tenant: found.tenant,
      scopes: found.token.scopes,
    };
  }

  async createTokenForMembership(input: {
    membership: Membership;
    actorId: string;
    body: CreateApiTokenInput;
  }): Promise<CreatedApiToken> {
    const parsed = CreateApiTokenInput.parse(input.body);
    const scopes = dedupeScopes(parsed.scopes);
    if (scopes.length === 0) {
      throw authError("SCOPE_REQUIRED", "至少需要一个作用域：read / write / approve");
    }
    const generated = generateApiToken();
    const expiresAt =
      parsed.expiresInDays === undefined
        ? null
        : new Date(Date.now() + parsed.expiresInDays * 24 * 60 * 60 * 1000);
    // 允许持有 approve 的只有人类（OIDC 会话或已持 approve 的凭据），
    // 调用方（控制器）已校验调用者权限。

    const tokenView = await this.access.createToken({
      membershipId: input.membership.id,
      tenantId: input.membership.tenantId,
      name: parsed.name,
      publicId: generated.publicId,
      tokenHash: hashToken(generated.token, this.pepper),
      scopes,
      expiresAt,
      actorId: input.actorId,
    });
    return { token: generated.token, tokenView };
  }

  async listTokens(membershipId: string): Promise<ApiToken[]> {
    return this.access.listTokens(membershipId);
  }

  async revokeToken(input: {
    membership: Membership;
    actorId: string;
    tokenId: string;
  }): Promise<ApiToken> {
    const revoked = await this.access.revokeToken({
      membershipId: input.membership.id,
      tenantId: input.membership.tenantId,
      tokenId: input.tokenId,
      actorId: input.actorId,
    });
    if (!revoked) throw authError("INVALID_TOKEN", "token 不存在或不属于当前账号");
    return revoked;
  }

  /** CLI 发起登录：生成 device_code（给 CLI）与 user_code（给人类）。 */
  async startDevice(input: { clientName?: string }): Promise<DeviceAuthorizationStart> {
    const deviceCode = generateDeviceCode();
    const ttl = this.env.DEVICE_CODE_TTL_SECONDS;
    const interval = this.env.DEVICE_POLL_INTERVAL_SECONDS;

    // 确认码空间 32^8，碰撞概率极低；万一撞上唯一索引就换一个重试。
    let userCode = generateUserCode();
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.access.createDeviceAuthorization({
          deviceCodeHash: hashSecret(deviceCode, this.pepper),
          userCode,
          clientName: input.clientName?.trim() || null,
          expiresAt: new Date(Date.now() + ttl * 1000),
          intervalSeconds: interval,
        });
        break;
      } catch (error) {
        if (attempt >= 2 || !isUniqueViolation(error)) throw error;
        userCode = generateUserCode();
      }
    }

    const verificationUri = `${this.webUrl}/cli-login`;
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
      expiresIn: ttl,
      interval,
    };
  }

  /** 已登录的人类在确认页上批准 / 拒绝。身份来自 OIDC 会话，不由表单自报。 */
  async decideDevice(input: {
    decision: DeviceAuthorizationDecision;
    membership: Membership;
  }): Promise<{ userCode: string; approved: boolean; subject: string }> {
    const parsed = DeviceAuthorizationDecision.parse(input.decision);
    const userCode = normalizeUserCode(parsed.userCode);
    const device = await this.access.findDeviceByUserCode(userCode);
    if (!device) throw authError("INVALID_USER_CODE", "确认码不存在，请检查后重试");
    if (device.expiresAt.getTime() <= Date.now()) {
      throw authError("USER_CODE_EXPIRED", "确认码已过期，请在 CLI 重新执行 weave login");
    }
    if (device.status !== "PENDING") {
      throw authError("INVALID_USER_CODE", "该确认码已被使用，请在 CLI 重新执行 weave login");
    }

    if (!parsed.approve) {
      await this.access.decideDevice({ userCode, approve: false, membershipId: null, scopes: [] });
      return { userCode, approved: false, subject: input.membership.subject };
    }

    const scopes = dedupeScopes(parsed.scopes);
    await this.access.decideDevice({
      userCode,
      approve: true,
      membershipId: input.membership.id,
      scopes,
    });
    return { userCode, approved: true, subject: input.membership.subject };
  }

  /** CLI 轮询：pending / slow_down / approved / denied / expired。 */
  async pollDevice(deviceCode: string) {
    const hash = hashSecret(deviceCode.trim(), this.pepper);
    const device = await this.access.findDeviceByCodeHash(hash);
    if (!device) throw authError("DEVICE_CODE_INVALID", "登录会话不存在，请重新执行 weave login");

    if (device.status === "CONSUMED") {
      throw authError("DEVICE_CODE_INVALID", "登录会话已换取过凭据，请重新执行 weave login");
    }
    if (device.status === "DENIED") return { status: "denied" as const };
    if (device.expiresAt.getTime() <= Date.now() && device.status === "PENDING") {
      return { status: "expired" as const };
    }

    if (device.status === "PENDING") {
      const intervalMs = device.intervalSeconds * 1000;
      const last = device.lastPolledAt?.getTime() ?? 0;
      if (Date.now() - last < intervalMs) {
        return { status: "slow_down" as const, interval: device.intervalSeconds + 5 };
      }
      await this.access.markDevicePolled(device.id);
      return { status: "pending" as const };
    }

    // APPROVED：一次性消费，再签发 token（并发轮询只有一个能走到这里）。
    const consumed = await this.access.consumeDevice(hash);
    if (!consumed || !consumed.membershipId) {
      throw authError("DEVICE_CODE_INVALID", "登录会话已失效，请重新执行 weave login");
    }
    const context = await this.access.getMembershipContext(consumed.membershipId);
    if (!context) throw authError("INVALID_TOKEN", "账号不存在");

    const created = await this.createTokenForMembership({
      membership: context.membership,
      actorId: `oidc:${context.membership.subject}`,
      body: {
        name: consumed.clientName ?? "CLI login",
        scopes: (consumed.scopes ?? ["read", "write"]) as TokenScope[],
      },
    });
    return {
      status: "approved" as const,
      token: created.token,
      tokenView: created.tokenView,
      membership: context.membership,
      tenant: context.tenant,
    };
  }

  /** CLI 自述：凭据 + 成员身份 + 租户。 */
  async identity(membership: Membership, token: ApiToken | null): Promise<PersonalAccessIdentity> {
    const context = await this.access.getMembershipContext(membership.id);
    if (!context) throw authError("INVALID_TOKEN", "成员身份不存在");
    return {
      subject: context.membership.subject,
      tenant: context.tenant,
      membership: context.membership,
      token,
    };
  }
}
