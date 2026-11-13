import { openTenantSession } from "@weave-order/db";
import type { Pool } from "pg";
import { AuthClaims, AuthContextResponse } from "@weave-order/schema";
import type { ApiToken, Membership, TokenScope } from "@weave-order/schema";
import { createKernel } from "../kernel";
import type { Kernel } from "../kernel";
import { authError } from "../auth/errors";
import { PersonalAccessService } from "../auth/personal-access.service";

/**
 * 认证后的租户作用域。
 *
 * 一条请求 = 一条独占连接 + 绑定 tenantId 的内核；请求结束必须 release()。
 * 所有业务读写都发生在 `app.tenant_id` 已设置的会话里（铁律 G4）。
 */
export interface TenantScope {
  kernel: Kernel;
  release(): Promise<void>;
}

/** 认证结果：OIDC 令牌没有作用域；PAT 带上作用域与凭据视图。 */
export interface AuthenticatedIdentity {
  claims: AuthClaims;
  membership: Membership;
  tokenScopes?: TokenScope[];
  tokenView?: ApiToken;
}

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly verifier: { verify(token: string): Promise<AuthClaims> },
    /** 平台/控制面连接：只用于把 (sub) 映射到本地 membership。 */
    private readonly directory: Kernel,
    /** 个人访问凭据（CLI / agent）：与 OIDC 共用同一条 membership → 租户链路。 */
    private readonly personalTokens: PersonalAccessService,
  ) {}

  private bearer(header: string | undefined): string {
    const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
    if (!match?.[1]) {
      throw new Error("缺少 Bearer 令牌");
    }
    return match[1];
  }

  async authenticate(header: string | undefined): Promise<AuthenticatedIdentity> {
    const token = this.bearer(header);

    // 个人访问凭据：直接绑定 membership，不再走 (sub, org) 目录查询。
    if (token.startsWith("wo_")) {
      const verified = await this.personalTokens.verify(token);
      if (!verified) {
        throw authError("INVALID_TOKEN", "凭据无效，请重新执行 weave login");
      }
      const membership = verified.membership;
      if (membership.status !== "ACTIVE") {
        throw new Error("成员身份未启用");
      }
      const claims = AuthClaims.parse({
        sub: membership.subject,
        org: membership.casdoorOrg,
        name: null,
        email: null,
        issuer: "weave-order",
        audience: "personal-access-token",
        // PAT 的有效期由 api_tokens.expires_at 判定；这里的 exp 只满足契约。
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      });
      return {
        claims,
        membership,
        tokenScopes: verified.scopes,
        tokenView: verified.token,
      };
    }

    const claims = await this.verifier.verify(token);
    const membership = await this.directory.tenancy.resolveMembership(claims.sub, claims.org);
    return { claims, membership };
  }

  async me(header: string | undefined): Promise<AuthContextResponse> {
    const { claims, membership } = await this.authenticate(header);
    const tenant = await this.directory.tenancy.getTenant(membership.tenantId);
    return AuthContextResponse.parse({
      subject: claims.sub,
      name: claims.name,
      email: claims.email,
      tenant,
      membership,
    });
  }

  async openScope(membership: Membership): Promise<TenantScope> {
    const session = await openTenantSession(this.pool, membership.tenantId);
    const kernel = createKernel(session.db, undefined, { tenantId: membership.tenantId });
    return {
      kernel,
      release: () => session.release(),
    };
  }
}
