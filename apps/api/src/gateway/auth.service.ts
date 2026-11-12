import { openTenantSession } from "@weave-order/db";
import type { Pool } from "pg";
import { AuthContextResponse } from "@weave-order/schema";
import type { AuthClaims, Membership } from "@weave-order/schema";
import { createKernel } from "../kernel";
import type { Kernel } from "../kernel";

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

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly verifier: { verify(token: string): Promise<AuthClaims> },
    /** 平台/控制面连接：只用于把 (sub) 映射到本地 membership。 */
    private readonly directory: Kernel,
  ) {}

  private bearer(header: string | undefined): string {
    const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
    if (!match?.[1]) {
      throw new Error("缺少 Bearer 令牌");
    }
    return match[1];
  }

  async authenticate(header: string | undefined): Promise<{
    claims: AuthClaims;
    membership: Membership;
  }> {
    const claims = await this.verifier.verify(this.bearer(header));
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
