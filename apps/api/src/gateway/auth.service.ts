import { openTenantSession } from "@weave-order/db";
import type { Pool } from "pg";
import { AuthClaims, AuthContextResponse, SwitchTenantInput } from "@weave-order/schema";
import type {
  ApiToken,
  AuthMeResponse,
  Membership,
  TenantChoicesResponse,
  TokenScope,
} from "@weave-order/schema";
import { createKernel } from "../kernel";
import type { Kernel } from "../kernel";
import { isKernelError } from "../kernel";
import { authError } from "../auth/errors";
import { PersonalAccessService } from "../auth/personal-access.service";
import type { SessionRecord, SessionService } from "./session.service";

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
  /** 会话凭据（Cookie）解析出的 sid；OIDC / PAT 请求没有。 */
  sid?: string;
}

/** 会话凭据的形态：网关中间件把 Cookie 归一成 `Bearer session:<sid>`。 */
export const SESSION_CREDENTIAL_PREFIX = "session:";

export interface AuthResponse<T> {
  body: T;
  /** 非空时网关要给浏览器下发/更新会话 Cookie。 */
  sid: string | null;
}

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly verifier: { verify(token: string): Promise<AuthClaims> },
    /** 平台/控制面连接：只用于把 (sub) 映射到本地 membership。 */
    private readonly directory: Kernel,
    /** 个人访问凭据（CLI / agent）：与 OIDC 共用同一条 membership → 租户链路。 */
    private readonly personalTokens: PersonalAccessService,
    /** 租户会话（Redis / 进程内）。`tenant_id` 只存在于会话里，前端拿不到。 */
    private readonly sessions: SessionService,
  ) {}

  private bearer(header: string | undefined): string {
    const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
    if (!match?.[1]) {
      throw authError("AUTH_REQUIRED", "缺少 Bearer 令牌");
    }
    return match[1];
  }

  /** `Bearer session:<sid>` → sid；其他凭据返回 null。 */
  private sessionCredential(token: string): string | null {
    if (!token.startsWith(SESSION_CREDENTIAL_PREFIX)) return null;
    const sid = token.slice(SESSION_CREDENTIAL_PREFIX.length).trim();
    return sid.length > 0 ? sid : null;
  }

  private claimsForSession(record: SessionRecord): AuthClaims {
    return AuthClaims.parse({
      sub: record.sub,
      org: null,
      name: record.name,
      email: record.email,
      issuer: "weave-order",
      audience: "tenant-session",
      // 会话有效期由 Redis TTL 判定；exp 只满足契约形状。
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
  }

  /**
   * 业务请求的身份解析。
   *
   * 顺序：会话 Cookie → PAT（`wo_`）→ Casdoor OIDC。
   * 会话路径每个请求都重新 `resolveMembership(sub, tenantId)`，所以成员被停用、
   * 角色被调整会立刻生效，不需要等会话过期。
   */
  async authenticate(header: string | undefined): Promise<AuthenticatedIdentity> {
    const token = this.bearer(header);

    const sid = this.sessionCredential(token);
    if (sid) {
      const record = await this.sessions.read(sid);
      if (!record) {
        throw authError("AUTH_REQUIRED", "会话已过期，请重新登录");
      }
      if (!record.tenantId) {
        throw authError("TENANT_REQUIRED", "该账号属于多个公司，请先选择公司");
      }
      const membership = await this.resolveOrThrow(record.sub, record.tenantId);
      return { claims: this.claimsForSession(record), membership, sid };
    }

    // 个人访问凭据：直接绑定 membership，不再走 (sub, org) 目录查询。
    if (token.startsWith("wo_")) {
      const verified = await this.personalTokens.verify(token);
      if (!verified) {
        throw authError("INVALID_TOKEN", "凭据无效，请重新执行 weave login");
      }
      const membership = verified.membership;
      if (membership.status !== "ACTIVE") {
        throw authError("INVALID_TOKEN", "成员身份未启用");
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
    const membership = await this.resolveOidcMembership(claims);
    return { claims, membership };
  }

  /**
   * OIDC 直连（没有会话）时的租户解析：只有「恰好 1 条 ACTIVE」才自动绑定。
   * 多租户账号必须显式走 `/api/auth/me` → `/api/auth/switch`。
   */
  private async resolveOidcMembership(claims: AuthClaims): Promise<Membership> {
    const choices = await this.directory.tenancy.listTenantChoices(claims.sub);
    if (choices.length === 0) {
      throw authError("NO_MEMBERSHIP", "该账号还没有加入任何公司");
    }
    const active = choices.filter((choice) => choice.membershipStatus === "ACTIVE");
    if (active.length > 1) {
      throw authError("TENANT_REQUIRED", "该账号属于多个公司，请先选择公司");
    }
    if (active.length === 0 || active[0]?.available !== true) {
      throw authError("TENANT_UNAVAILABLE", "你在该公司的权限已不可用，请重新登录");
    }
    return this.directory.tenancy.resolveSoleMembership(claims.sub, claims.org);
  }

  private async resolveOrThrow(subject: string, tenantId: string): Promise<Membership> {
    try {
      return await this.directory.tenancy.resolveMembership(subject, tenantId);
    } catch (error) {
      if (isKernelError(error) && error.code === "PERMISSION_DENIED") {
        throw authError("TENANT_UNAVAILABLE", "你在该公司的权限已被收回，请重新选择公司");
      }
      throw error;
    }
  }

  private choicesBody(
    subject: string,
    name: string | null,
    email: string | null,
    choices: TenantChoicesResponse["tenants"],
  ): TenantChoicesResponse {
    return {
      status: "MULTI_TENANT",
      subject,
      name,
      email,
      tenants: choices,
    };
  }

  /**
   * `GET /api/auth/me`：
   * - 已绑定租户 → `AuthContextResponse`（单租户自动进入，或已经选过）；
   * - 已认证未选租户 → `TenantChoicesResponse`（前端渲染选择页）；
   * - 一条 ACTIVE 都没有 → 403 `NO_MEMBERSHIP`（前端渲染「未加入公司」页）。
   *
   * 绑定的租户如果中途不可用，这里不直接 403，而是退回选择页并重新签发
   * 一个未绑定会话：用户能看到「权限已被收回」，而不是撞上一句裸 403。
   */
  async me(header: string | undefined, sid: string | null): Promise<AuthResponse<AuthMeResponse>> {
    const token = this.bearer(header);

    if (token.startsWith("wo_")) {
      const identity = await this.authenticate(header);
      return { body: await this.contextBody(identity), sid: null };
    }

    // 会话凭据：读记录，再按记录里的 tenantId 重新校验 membership。
    const fromSession = this.sessionCredential(token);
    if (fromSession) {
      const record = await this.sessions.read(fromSession);
      if (!record) throw authError("AUTH_REQUIRED", "会话已过期，请重新登录");
      if (!record.tenantId) {
        return { body: await this.chooserBody(record.sub, record.name, record.email), sid };
      }
      try {
        const membership = await this.directory.tenancy.resolveMembership(
          record.sub,
          record.tenantId,
        );
        const next = await this.sessions.read(fromSession);
        return {
          body: await this.contextBody({
            claims: this.claimsForSession(next ?? record),
            membership,
            sid: fromSession,
          }),
          sid,
        };
      } catch (error) {
        if (!isKernelError(error) || error.code !== "PERMISSION_DENIED") throw error;
        // 权限被收回：解绑并回退到选择页（或零租户错误）。
        const rebound = await this.sessions.rebind(fromSession, record, { tenantId: null });
        return {
          body: await this.chooserBody(record.sub, record.name, record.email),
          sid: rebound.sid,
        };
      }
    }

    // Casdoor OIDC：首次登录可能还没有会话，这里补建一条。
    const claims = await this.verifier.verify(token);
    const choices = await this.directory.tenancy.listTenantChoices(claims.sub);
    if (choices.length === 0) {
      throw authError("NO_MEMBERSHIP", "该账号还没有加入任何公司");
    }
    const active = choices.filter((choice) => choice.membershipStatus === "ACTIVE");
    // 只有「恰好一家且可进入」才自动绑定；0 家可用（全停用 / 全关闭）时要让
    // 用户看到原因（可见不可进），而不是伪装成单租户直接进一个关闭的公司。
    const autoBind = active.length === 1 && active[0]?.available === true;
    if (!autoBind) {
      const session = await this.sessions.create({
        sub: claims.sub,
        name: claims.name,
        email: claims.email,
        tenantId: null,
      });
      return {
        body: this.choicesBody(claims.sub, claims.name, claims.email, choices),
        sid: session.sid,
      };
    }
    const membership = await this.directory.tenancy.resolveSoleMembership(claims.sub, claims.org);
    const session = await this.sessions.create({
      sub: claims.sub,
      name: claims.name,
      email: claims.email,
      tenantId: membership.tenantId,
    });
    const body = await this.contextBody({
      claims: this.claimsForSession(session.record),
      membership,
      sid: session.sid,
    });
    return { body, sid: session.sid };
  }

  /**
   * 只验签、不要求已有成员身份。
   *
   * 唯一用途是开通：新老板第一次进来时业务库里还没有他的 membership，
   * 只要令牌可信就允许他领取开通链接。除开通外不要使用——业务请求必须走
   * `authenticate()` 拿到租户上下文。
   */
  async verifyClaims(header: string | undefined): Promise<AuthClaims> {
    const token = this.bearer(header);
    if (token.startsWith("wo_")) {
      throw authError("INVALID_TOKEN", "开通请先登录，再打开开通链接");
    }
    return this.verifier.verify(token);
  }

  private async chooserBody(
    subject: string,
    name: string | null,
    email: string | null,
  ): Promise<TenantChoicesResponse> {
    const choices = await this.directory.tenancy.listTenantChoices(subject);
    if (choices.length === 0) {
      throw authError("NO_MEMBERSHIP", "该账号还没有加入任何公司");
    }
    return this.choicesBody(subject, name, email, choices);
  }

  private async contextBody(identity: AuthenticatedIdentity): Promise<AuthContextResponse> {
    const tenant = await this.directory.tenancy.getTenant(identity.membership.tenantId);
    return AuthContextResponse.parse({
      subject: identity.claims.sub,
      name: identity.claims.name,
      email: identity.claims.email,
      tenant,
      membership: identity.membership,
    });
  }

  /**
   * `GET /api/auth/tenants`：只读选择列表。
   * 恒返回该 subject 自己的成员关系，`PAT` 也允许读（agent 需要知道自己的绑定）。
   */
  async tenants(
    header: string | undefined,
    sid: string | null,
  ): Promise<AuthResponse<TenantChoicesResponse>> {
    const token = this.bearer(header);
    if (token.startsWith("wo_")) {
      const identity = await this.authenticate(header);
      // PAT 绑定单条 membership：列表只回这一条，字段与真实选择器同形。
      const choices = await this.directory.tenancy.listTenantChoices(identity.claims.sub);
      const bound = choices.find((choice) => choice.tenantId === identity.membership.tenantId);
      return {
        body: this.choicesBody(identity.claims.sub, null, null, bound ? [bound] : []),
        sid: null,
      };
    }
    const subject = await this.subjectOf(token);
    const record = await this.sessionRecordFor(token, sid);
    return {
      body: await this.chooserBody(subject, record?.name ?? null, record?.email ?? null),
      sid,
    };
  }

  /** 取凭据对应的 subject：会话优先，其次 OIDC。 */
  private async subjectOf(token: string): Promise<string> {
    const fromSession = this.sessionCredential(token);
    if (fromSession) {
      const record = await this.sessions.read(fromSession);
      if (!record) throw authError("AUTH_REQUIRED", "会话已过期，请重新登录");
      return record.sub;
    }
    const claims = await this.verifier.verify(token);
    return claims.sub;
  }

  private async sessionRecordFor(token: string, sid: string | null): Promise<SessionRecord | null> {
    const fromSession = this.sessionCredential(token);
    if (fromSession) return this.sessions.read(fromSession);
    if (sid) return this.sessions.read(sid);
    return null;
  }

  /**
   * `POST /api/auth/switch`：选择 / 切换租户。
   *
   * - 身份必须来自会话或 OIDC；PAT 一律拒绝（agent 不能借切换扩大租户范围）。
   * - 目标必须有一条 ACTIVE membership，否则 403，且不区分「不存在」与「无权限」。
   * - 切换成功重新签发 sid（防会话固定），先审计再换绑：审计失败切换也失败。
   */
  async switchTenant(
    header: string | undefined,
    sid: string | null,
    body: unknown,
  ): Promise<AuthResponse<AuthContextResponse>> {
    const input = SwitchTenantInput.parse(body);
    const token = this.bearer(header);
    if (token.startsWith("wo_")) {
      throw authError("SCOPE_REQUIRED", "个人访问凭据已绑定单一公司，不能切换租户");
    }

    const fromSession = this.sessionCredential(token);
    let record: SessionRecord | null = null;
    let claims: AuthClaims | null = null;
    if (fromSession) {
      record = await this.sessions.read(fromSession);
      if (!record) throw authError("AUTH_REQUIRED", "会话已过期，请重新登录");
    } else {
      claims = await this.verifier.verify(token);
    }
    const subject = record?.sub ?? claims?.sub;
    if (!subject) throw authError("AUTH_REQUIRED", "缺少身份凭据");

    const fromTenantId = record?.tenantId ?? null;
    let membership: Membership;
    try {
      membership = await this.directory.tenancy.resolveMembership(subject, input.tenantId);
    } catch (error) {
      if (isKernelError(error) && error.code === "PERMISSION_DENIED") {
        // 拒绝也留痕（落在 from 租户）；没有 from 时不猜租户，避免把噪声写进别人的账本。
        await this.directory.tenancy.recordTenantSwitch({
          subject,
          fromTenantId,
          toTenantId: input.tenantId,
          membershipId: null,
          result: "DENIED",
        });
        throw authError("TENANT_UNAVAILABLE", "你没有这家公司的权限，请确认后重新选择");
      }
      throw error;
    }

    // 审计先于会话换绑：审计写不进去，就不允许「切了但没记」。
    await this.directory.tenancy.recordTenantSwitch({
      subject,
      fromTenantId,
      toTenantId: membership.tenantId,
      membershipId: membership.id,
      result: "ALLOWED",
    });

    const base: SessionRecord = record ?? {
      sub: subject,
      name: claims?.name ?? null,
      email: claims?.email ?? null,
      tenantId: null,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    const rebound = await this.sessions.rebind(fromSession ?? sid, base, {
      tenantId: membership.tenantId,
    });
    const context = await this.contextBody({
      claims: this.claimsForSession(rebound.record),
      membership,
      sid: rebound.sid,
    });
    return { body: context, sid: rebound.sid };
  }

  /** 登出：删 Redis 会话（幂等），Cookie 由控制器清除。 */
  async logout(header: string | undefined, sid: string | null): Promise<void> {
    const candidates = new Set<string>();
    if (sid) candidates.add(sid);
    const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
    const token = match?.[1];
    if (token) {
      const fromHeader = this.sessionCredential(token);
      if (fromHeader) candidates.add(fromHeader);
    }
    for (const candidate of candidates) {
      await this.sessions.destroy(candidate);
    }
  }

  /** 会话 Cookie 的有效期（秒），与 Redis TTL 一致。 */
  ttl(): number {
    return this.sessions.ttl;
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
