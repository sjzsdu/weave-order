import {
  ApiTokenList,
  AuthIdentity,
  CreateApiTokenInput,
  DeviceAuthorizationDecision,
  DeviceAuthorizationPollResult,
  TOKEN_SCOPES,
} from "@weave-order/schema";
import type {
  ApiToken,
  CreatedApiToken,
  DeviceAuthorizationStart,
  TokenScope,
  WeaveUser,
} from "@weave-order/schema";
import type { Kernel } from "../kernel";
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

/** 已认证的请求身份：谁（user）+ 用哪个凭据（token）。 */
export interface AuthContext {
  user: WeaveUser;
  token: ApiToken;
}

function dedupeScopes(scopes: readonly TokenScope[]): TokenScope[] {
  return TOKEN_SCOPES.filter((scope) => scopes.includes(scope));
}

/**
 * 凭据服务的应用层：只做「生成 / 校验 / 流程编排」，不碰数据库。
 * 所有读写都经 kernel.access（唯一写入者，签发与撤销自动落审计）。
 */
export class AuthService {
  private readonly env = loadEnv();

  /** 由 HTTP 组合根注入内核句柄；测试可直接 new AuthService(kernel)。 */
  constructor(private readonly kernel: Kernel) {}

  /** 生产环境强制要求凭据；开发环境保留匿名只读入口，便于本地页面直接跑。 */
  get authRequired(): boolean {
    return this.env.AUTH_REQUIRED || this.env.NODE_ENV === "production";
  }

  private get pepper(): string {
    return this.env.AUTH_TOKEN_PEPPER;
  }

  private get publicUrl(): string {
    return this.env.PUBLIC_API_URL.replace(/\/+$/, "");
  }

  /** 签发个人 token；明文只在这里返回一次。 */
  async createTokenForUser(input: {
    userId: string;
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

    const tokenView = await this.kernel.access.createToken({
      userId: input.userId,
      name: parsed.name,
      publicId: generated.publicId,
      tokenHash: hashToken(generated.token, this.pepper),
      scopes,
      expiresAt,
      actorId: input.actorId,
    });
    return { token: generated.token, tokenView };
  }

  async listTokens(userId: string): Promise<ApiTokenList> {
    return { tokens: await this.kernel.access.listTokens(userId) };
  }

  async revokeToken(input: {
    userId: string;
    actorId: string;
    tokenId: string;
  }): Promise<ApiToken> {
    const revoked = await this.kernel.access.revokeToken(input);
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
        await this.kernel.access.createDeviceAuthorization({
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

    const verificationUri = `${this.publicUrl}/cli-login`;
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
      expiresIn: ttl,
      interval,
    };
  }

  /** 人类在确认页上的决定（批准 / 拒绝）。 */
  async decideDevice(input: DeviceAuthorizationDecision): Promise<{
    userCode: string;
    approved: boolean;
    email: string;
  }> {
    const parsed = DeviceAuthorizationDecision.parse(input);
    const userCode = normalizeUserCode(parsed.userCode);
    const device = await this.kernel.access.findDeviceByUserCode(userCode);
    if (!device) throw authError("INVALID_USER_CODE", "确认码不存在，请检查后重试");
    if (device.expiresAt.getTime() <= Date.now()) {
      throw authError("USER_CODE_EXPIRED", "确认码已过期，请在 CLI 重新执行 weave login");
    }
    if (device.status !== "PENDING") {
      throw authError("INVALID_USER_CODE", "该确认码已被使用，请在 CLI 重新执行 weave login");
    }

    if (!parsed.approve) {
      await this.kernel.access.decideDevice({ userCode, approve: false, userId: null, scopes: [] });
      return { userCode, approved: false, email: parsed.email };
    }

    const user = await this.kernel.access.findOrCreateUser({
      email: parsed.email,
      name: parsed.name,
    });
    const scopes = dedupeScopes(parsed.scopes);
    await this.kernel.access.decideDevice({ userCode, approve: true, userId: user.id, scopes });
    return { userCode, approved: true, email: user.email };
  }

  /** CLI 轮询：pending / slow_down / approved / denied / expired。 */
  async pollDevice(deviceCode: string): Promise<DeviceAuthorizationPollResult> {
    const hash = hashSecret(deviceCode.trim(), this.pepper);
    const device = await this.kernel.access.findDeviceByCodeHash(hash);
    if (!device) throw authError("DEVICE_CODE_INVALID", "登录会话不存在，请重新执行 weave login");

    if (device.status === "CONSUMED") {
      throw authError("DEVICE_CODE_INVALID", "登录会话已换取过凭据，请重新执行 weave login");
    }
    if (device.status === "DENIED") return { status: "denied" };
    if (device.expiresAt.getTime() <= Date.now() && device.status === "PENDING") {
      return { status: "expired" };
    }

    if (device.status === "PENDING") {
      const intervalMs = device.intervalSeconds * 1000;
      const last = device.lastPolledAt?.getTime() ?? 0;
      if (Date.now() - last < intervalMs) {
        return { status: "slow_down", interval: device.intervalSeconds + 5 };
      }
      await this.kernel.access.markDevicePolled(device.id);
      return { status: "pending" };
    }

    // APPROVED：一次性消费，再签发 token（并发轮询只有一个能走到这里）。
    const consumed = await this.kernel.access.consumeDevice(hash);
    if (!consumed || !consumed.userId) {
      throw authError("DEVICE_CODE_INVALID", "登录会话已失效，请重新执行 weave login");
    }
    const user = await this.kernel.access.getUser(consumed.userId);
    if (!user) throw authError("INVALID_TOKEN", "账号不存在");

    const created = await this.createTokenForUser({
      userId: user.id,
      actorId: `user:${user.id}`,
      body: {
        name: consumed.clientName ?? "CLI login",
        scopes: (consumed.scopes ?? ["read", "write"]) as TokenScope[],
      },
    });
    return { status: "approved", token: created.token, tokenView: created.tokenView, user };
  }

  /** 校验 `Authorization: Bearer <token>`；没有凭据时返回 null（是否放行由守卫决定）。 */
  async authenticate(header: string | undefined): Promise<AuthContext | null> {
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match?.[1]) throw authError("INVALID_TOKEN", "Authorization 头格式应为 `Bearer <token>`");

    const parsed = parseApiToken(match[1]);
    if (!parsed) throw authError("INVALID_TOKEN", "凭据格式不正确，请重新执行 weave login");

    const found = await this.kernel.access.findTokenByPublicId(parsed.publicId);
    if (!found || !hashesEqual(found.tokenHash, hashToken(match[1], this.pepper))) {
      throw authError("INVALID_TOKEN", "凭据无效，请重新执行 weave login");
    }
    if (found.token.status === "REVOKED") throw authError("TOKEN_REVOKED", "凭据已被撤销");
    if (found.token.status === "EXPIRED") throw authError("TOKEN_EXPIRED", "凭据已过期");

    void this.kernel.access.touchToken(found.token.id);
    return { user: found.user, token: found.token };
  }

  identity(auth: AuthContext): AuthIdentity {
    return { user: auth.user, token: auth.token };
  }
}
