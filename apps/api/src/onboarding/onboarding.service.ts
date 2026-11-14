import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  InvitePreview,
  InviteMemberInput,
  OnboardingPreview,
  OnboardingResult,
  StartTenantInput,
} from "@weave-order/schema";
import { TeamInvite, TeamInviteList } from "@weave-order/schema";
import type { AuthClaims, Membership } from "@weave-order/schema";
import { createKernel } from "../kernel";
import type { KernelContext } from "../kernel";
import { DatabaseProvider } from "../platform/database.provider";
import { loadEnv } from "../platform/env";
import {
  ONBOARDING_TICKET_TTL_SECONDS,
  OnboardingTicketError,
  signOnboardingTicket,
  verifyOnboardingTicket,
} from "./ticket";

/**
 * 开通（onboarding）服务。
 *
 * 边界：这里用**平台/owner 连接**写「租户 + 首个成员」，和迁移、seed 同一类操作；
 * 业务请求永远走租户会话。开通只做两件事，且都可重入：
 *   1. 按 slug 建租户（已有则复用）；
 *   2. 给当前登录账号建 OWNER 成员（已有则返回 alreadyActivated）。
 *
 * 为什么由业务侧建租户：控制面只存账号、订阅、用量，不允许写业务库；
 * 开通链接由控制面签发，业务侧验签后在本库落地。两边靠 slug 对齐。
 */
@Injectable()
export class OnboardingService {
  // 显式 token：tsx/esbuild 不产出 design:paramtypes，隐式注入会拿到 undefined。
  constructor(@Inject(DatabaseProvider) private readonly database: DatabaseProvider) {}

  private kernel() {
    return createKernel(this.database.handle.db);
  }

  private ticket(code: string) {
    try {
      return verifyOnboardingTicket(code, loadEnv().ONBOARDING_SECRET);
    } catch (error) {
      if (error instanceof OnboardingTicketError) throw error;
      throw new OnboardingTicketError("开通链接无效，请向对接人重新索取");
    }
  }

  private static systemContext(tenantId?: string): KernelContext {
    return {
      actor: { type: "SYSTEM", id: "onboarding" },
      ...(tenantId ? { tenantId } : {}),
    };
  }

  /** 打开链接先看一眼：这是哪家公司、我是否已经是成员、链接是否还有效。 */
  async preview(code: string, claims: AuthClaims): Promise<OnboardingPreview> {
    const ticket = this.ticket(code);
    const kernel = this.kernel();
    const tenant = await kernel.tenancy.findTenantBySlug(ticket.slug);
    const membership = tenant
      ? await kernel.tenancy.findMembershipForTenant(claims.sub, tenant.id)
      : null;
    return OnboardingPreview.parse({
      slug: ticket.slug,
      name: tenant?.name ?? ticket.name,
      ownerEmail: ticket.ownerEmail,
      expiresAt: new Date(ticket.exp * 1000).toISOString(),
      tenantExists: tenant !== null,
      membershipExists: membership !== null && tenant !== null && membership.tenantId === tenant.id,
    });
  }

  /**
   * 领取开通链接：建公司 + 成为老板。
   *
   * 邮箱校验：票据里登记了联系人邮箱，而登录账号也有邮箱时，两者必须一致。
   * 这样转发出去的链接不会被无关账号抢注；登录账号没有邮箱时明确报错，
   * 而不是静默放行。
   */
  async claim(code: string, claims: AuthClaims): Promise<OnboardingResult> {
    const ticket = this.ticket(code);
    const kernel = this.kernel();

    const expected = ticket.ownerEmail?.trim().toLowerCase() ?? null;
    const actual = claims.email?.trim().toLowerCase() ?? null;
    if (expected) {
      if (!actual) {
        throw new OnboardingTicketError(
          "这条开通链接要核对邮箱，但你的登录账号没有邮箱。请用登记时的邮箱账号登录，或让我们重新发一条不校验邮箱的链接。",
        );
      }
      if (expected !== actual) {
        throw new OnboardingTicketError(
          "登录邮箱与登记邮箱不一致。请用登记的邮箱登录，或让我们重新发一条给这个邮箱的链接。",
        );
      }
    }

    let tenant = await kernel.tenancy.findTenantBySlug(ticket.slug);
    const existing = tenant
      ? await kernel.tenancy.findMembershipForTenant(claims.sub, tenant.id)
      : null;

    if (existing) {
      if (tenant && existing.tenantId !== tenant.id) {
        throw new OnboardingTicketError(
          "这个账号已经属于另一家公司。一个人目前只能属于一家公司，请联系我们处理。",
        );
      }
      if (!tenant) {
        // 成员存在但租户不在：数据不一致，交给人工，不自动补建。
        throw new OnboardingTicketError("账号状态异常，请联系我们处理");
      }
      return OnboardingResult.parse({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        tenantName: tenant.name,
        membershipId: existing.id,
        role: existing.role,
        dataScope: existing.dataScope,
        alreadyActivated: true,
      });
    }

    if (!tenant) {
      tenant = await kernel.tenancy.createTenant(
        { slug: ticket.slug, name: ticket.name, casdoorOrg: claims.org },
        OnboardingService.systemContext(),
      );
    }

    const membership = await kernel.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: claims.sub,
        casdoorOrg: claims.org,
        role: "OWNER",
        dataScope: "ALL",
      },
      OnboardingService.systemContext(tenant.id),
    );

    return OnboardingResult.parse({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      membershipId: membership.id,
      role: membership.role,
      dataScope: membership.dataScope,
      alreadyActivated: false,
    });
  }

  /* ------------------------------------------------------------- 自助开通 */

  /**
   * 老板自助创建公司：登录后填个公司名就能开始用。
   *
   * 一个账号一间公司：已有成员身份时直接返回那间公司（幂等），不报错；
   * slug 冲突时提示换一个，不自动加后缀，避免「同一家公司建出两间」。
   */
  async start(claims: AuthClaims, raw: unknown): Promise<OnboardingResult> {
    const input = StartTenantInput.parse(raw);
    const kernel = this.kernel();

    const existing = await kernel.tenancy.findMembershipBySubject(claims.sub);
    if (existing) {
      const tenant = await kernel.tenancy.getTenant(existing.tenantId);
      return OnboardingResult.parse({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        tenantName: tenant.name,
        membershipId: existing.id,
        role: existing.role,
        dataScope: existing.dataScope,
        alreadyActivated: true,
      });
    }

    const slug = input.slug ?? `t-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const taken = await kernel.tenancy.findTenantBySlug(slug);
    if (taken) {
      throw new StartTenantConflict("这个公司标识已经被用了，换一个再试");
    }

    const tenant = await kernel.tenancy.createTenant(
      { slug, name: input.name, casdoorOrg: claims.org },
      OnboardingService.systemContext(),
    );
    const membership = await kernel.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: claims.sub,
        casdoorOrg: claims.org,
        role: "OWNER",
        dataScope: "ALL",
      },
      OnboardingService.systemContext(tenant.id),
    );

    // 控制面登记试用：失败不阻断使用，但会留下明显日志，运营可补录。
    await this.syncControlPlane({
      slug: tenant.slug,
      name: tenant.name,
      ownerEmail: claims.email,
    });

    return OnboardingResult.parse({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      membershipId: membership.id,
      role: membership.role,
      dataScope: membership.dataScope,
      alreadyActivated: false,
    });
  }

  /**
   * 把自助开通的公司登记到控制面（租户 + 3 天试用订阅）。
   *
   * 两个库没有分布式事务：控制面失败时公司仍然可用，只是账单视图里暂时缺一条，
   * 由运营按 slug 补录。宁可少一条账单，也不让用户点完「创建」发现进不去。
   */
  private async syncControlPlane(input: {
    slug: string;
    name: string;
    ownerEmail: string | null;
  }): Promise<void> {
    const env = loadEnv();
    const base = env.PLATFORM_API_URL?.replace(/\/$/, "");
    if (!base) return;
    try {
      const response = await fetch(`${base}/platform/api/internal/tenants`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-weave-internal": env.ONBOARDING_SECRET,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) {
        console.warn(`[onboarding] 控制面登记失败 ${response.status}：${input.slug}`);
      }
    } catch (error) {
      console.warn(`[onboarding] 控制面不可达，先放行使用：${input.slug}`, error);
    }
  }

  /** 邀请同事：只允许老板/主管；邀请先落 INVITED 成员，接受后换绑真实身份。 */
  async invite(actor: Membership, raw: unknown): Promise<TeamInvite> {
    if (actor.role !== "OWNER" && actor.role !== "MANAGER") {
      throw new TeamActionError("只有老板或主管可以邀请同事", 403);
    }
    const input = InviteMemberInput.parse(raw);
    const email = input.email.trim().toLowerCase();
    const kernel = this.kernel();
    const tenant = await kernel.tenancy.getTenant(actor.tenantId);
    const invited = await kernel.tenancy.inviteMember(
      { tenantId: tenant.id, email, role: input.role },
      OnboardingService.systemContext(tenant.id),
    );
    return this.toInvite(tenant.slug, tenant.name, invited);
  }

  /** 待接受与已加入的成员列表（邀请链接不落库，列表里不回传明文）。 */
  async listTeam(tenantId: string): Promise<ReturnType<typeof TeamInviteList.parse>> {
    const kernel = this.kernel();
    const memberships = await kernel.tenancy.listMemberships(tenantId);
    return TeamInviteList.parse({
      invites: memberships
        .filter((item) => item.status !== "DISABLED")
        .map((item) => ({
          membershipId: item.id,
          email: item.subject,
          role: item.role,
          status: item.status === "INVITED" ? "INVITED" : "ACTIVE",
          url: null,
          expiresAt: null,
          createdAt: item.createdAt,
        })),
    });
  }

  async previewInvite(code: string, claims: AuthClaims): Promise<InvitePreview> {
    const ticket = this.ticket(code);
    if (ticket.kind !== "invite") throw new TeamActionError("这不是邀请链接", 400);
    const kernel = this.kernel();
    const tenant = await kernel.tenancy.findTenantBySlug(ticket.slug);
    if (!tenant) throw new TeamActionError("这间公司不存在或已停用", 410);
    const existing = await kernel.tenancy.findMembershipBySubject(claims.sub);
    return InvitePreview.parse({
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      email: ticket.ownerEmail ?? "",
      role: ticket.role ?? "SALES",
      expiresAt: new Date(ticket.exp * 1000).toISOString(),
      alreadyMember: existing?.tenantId === tenant.id,
    });
  }

  /** 接受邀请：邮箱必须一致 → INVITED 转 ACTIVE → 返回可进入的公司。 */
  async acceptInvite(code: string, claims: AuthClaims): Promise<OnboardingResult> {
    const ticket = this.ticket(code);
    if (ticket.kind !== "invite") throw new TeamActionError("这不是邀请链接", 400);
    const email = ticket.ownerEmail?.trim().toLowerCase() ?? null;
    const actual = claims.email?.trim().toLowerCase() ?? null;
    if (!email) throw new TeamActionError("邀请链接缺少邮箱，请让邀请人重新发一条", 410);
    if (!actual || actual !== email) {
      throw new TeamActionError("请用被邀请的邮箱登录后再接受邀请，或让邀请人改成你这个邮箱", 403);
    }

    const kernel = this.kernel();
    const tenant = await kernel.tenancy.findTenantBySlug(ticket.slug);
    if (!tenant) throw new TeamActionError("这间公司不存在或已停用", 410);

    const existing = await kernel.tenancy.findMembershipBySubject(claims.sub);
    if (existing) {
      if (existing.tenantId !== tenant.id) {
        throw new TeamActionError("这个账号已经属于另一家公司，一个人目前只能属于一家公司", 409);
      }
      return OnboardingResult.parse({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        tenantName: tenant.name,
        membershipId: existing.id,
        role: existing.role,
        dataScope: existing.dataScope,
        alreadyActivated: true,
      });
    }

    const invited = await kernel.tenancy.findInvitedMembership(tenant.id, email);
    if (!invited) {
      throw new TeamActionError("这条邀请已被接受或已撤销，请让邀请人重新发一条", 410);
    }
    const membership = await kernel.tenancy.activateMembership(
      invited.id,
      claims.sub,
      claims.org,
      OnboardingService.systemContext(tenant.id),
    );
    return OnboardingResult.parse({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      membershipId: membership.id,
      role: membership.role,
      dataScope: membership.dataScope,
      alreadyActivated: false,
    });
  }

  /** 生成一条邀请链接（7 天）。链接只带公司、邮箱、角色与到期时间。 */
  toInvite(slug: string, name: string, membership: Membership): TeamInvite {
    const env = loadEnv();
    const code = signOnboardingTicket(
      {
        v: 1,
        kind: "invite",
        slug,
        name,
        ownerEmail: membership.subject,
        role: membership.role,
      },
      env.ONBOARDING_SECRET,
    );
    const base = env.WEB_APP_URL.replace(/\/$/, "");
    return TeamInvite.parse({
      membershipId: membership.id,
      email: membership.subject,
      role: membership.role,
      status: "INVITED",
      url: `${base}/join?code=${encodeURIComponent(code)}`,
      expiresAt: new Date(Date.now() + ONBOARDING_TICKET_TTL_SECONDS * 1000).toISOString(),
      createdAt: membership.createdAt,
    });
  }
}

/* --------------------------------------------------------------- 自助开通 */

/**
 * 老板自助创建公司。
 *
 * 与「平台发开通链接」的区别：不再需要人审核、也不需要 slug 由平台分配。
 * 仍然限制一个账号只能属于一间公司（数据模型如此），重复调用直接返回已建好的那间。
 */
export class StartTenantConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartTenantConflict";
  }
}

/** 邀请相关的业务错误：403（没权限）/ 410（链接失效）/ 409（已经加入或占用）。 */
export class TeamActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TeamActionError";
  }
}
