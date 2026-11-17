import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  InvitePreview,
  InviteMemberInput,
  EntityId,
  OnboardingPreview,
  OnboardingResult,
  StartTenantInput,
} from "@weave-order/schema";
import { TeamInvite, TeamInviteList, hasCapability } from "@weave-order/schema";
import type { AuthClaims, Membership } from "@weave-order/schema";
import { createNotifier, inviteMessage } from "@weave-order/notify";
import { createKernel, isKernelError } from "../kernel";
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
      // 同样登记控制面 outbox：无论走开通链接还是自助创建，
      // 租户落地都必须伴随一条可靠的登记意图，杜绝总后台漏记录。
      tenant = await kernel.tenancy.createTenant(
        { slug: ticket.slug, name: ticket.name, casdoorOrg: claims.org },
        OnboardingService.systemContext(),
        {
          slug: ticket.slug,
          name: ticket.name,
          ownerEmail: ticket.ownerEmail ?? claims.email ?? null,
        },
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
   * 已经有公司时直接返回最早加入的那间（幂等，避免重复点击建出两家）；
   * 多公司入口由登录后的租户选择器负责，这里不重复创建。
   * slug 冲突时提示换一个，不自动加后缀。
   */
  async start(claims: AuthClaims, raw: unknown): Promise<OnboardingResult> {
    const input = StartTenantInput.parse(raw);
    const kernel = this.kernel();

    const choices = await kernel.tenancy.listTenantChoices(claims.sub);
    const active = choices.find((choice) => choice.membershipStatus === "ACTIVE");
    if (active) {
      const existing = await kernel.tenancy.findMembershipForTenant(claims.sub, active.tenantId);
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
    }

    const slug = input.slug ?? `t-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const taken = await kernel.tenancy.findTenantBySlug(slug);
    if (taken) {
      throw new StartTenantConflict("这个公司标识已经被用了，换一个再试");
    }

    // 控制面登记意图与租户在同一事务写入（Transactional Outbox）：
    // 租户落地 ⟺ outbox 落地，后续由投递 worker 可靠同步到控制面。
    const tenant = await kernel.tenancy.createTenant(
      { slug, name: input.name, casdoorOrg: claims.org },
      OnboardingService.systemContext(),
      { slug, name: input.name, ownerEmail: claims.email ?? null },
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

    // 套餐内含 credits → 本租户的月度 token 预算（1 credit = 1,000 tokens）。
    // 用创建者本人的身份写入：LLM 设置变更必须由人类发起，这里他正是在接受套餐。
    try {
      const tenantKernel = createKernel(this.database.handle.db, undefined, {
        tenantId: tenant.id,
      });
      await tenantKernel.llmSettings.upsertTenant(
        { monthlyTokenBudget: loadEnv().DEFAULT_MONTHLY_CREDITS * 1000 },
        {
          actor: { type: "HUMAN", id: claims.sub, role: "OWNER" },
          tenantId: tenant.id,
        },
      );
    } catch (error) {
      console.warn(`[onboarding] 初始化 credits 预算失败（不影响开通）：${tenant.id}`, error);
    }

    // 控制面登记已改为 outbox + 可靠投递 worker + 定时对账三道防线，
    // 不再在这里裸调 HTTP（失败即吞）。登记意图已在 createTenant 同事务落库。

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
   * 邀请同事：只允许老板/主管；邀请先落 INVITED 成员，接受后换绑真实身份。
   * 生成链接后立即尝试发送（邮件默认、短信需手机号）；没配置发送通道时如实返回 ok:false。
   */
  async invite(actor: Membership, raw: unknown, inviterName = "公司管理员"): Promise<TeamInvite> {
    // 能力表 `member.invite`：老板/主管才可邀请。
    if (!hasCapability(actor, "member.invite")) {
      throw new TeamActionError("只有老板或主管可以邀请同事", 403);
    }
    const input = InviteMemberInput.parse(raw);
    const email = input.email.trim().toLowerCase();
    if (input.channel === "sms" && !input.phone) {
      throw new TeamActionError("选短信通知需要填手机号", 400);
    }
    const kernel = this.kernel();
    const tenant = await kernel.tenancy.getTenant(actor.tenantId);
    const invited = await kernel.tenancy.inviteMember(
      { tenantId: tenant.id, email, role: input.role },
      OnboardingService.systemContext(tenant.id),
    );
    const invite = this.toInvite(tenant.slug, tenant.name, invited);

    const env = loadEnv();
    const notifier = createNotifier({
      provider: env.NOTIFY_PROVIDER,
      webhookUrl: env.NOTIFY_WEBHOOK_URL,
      token: env.NOTIFY_TOKEN,
    });
    const delivery = await notifier.send(
      inviteMessage({
        channel: input.channel,
        to: input.channel === "sms" ? (input.phone as string) : email,
        inviterName,
        tenantName: tenant.name,
        url: invite.url as string,
        expiresAt: new Date(invite.expiresAt as string),
      }),
    );

    return TeamInvite.parse({
      ...invite,
      delivery: {
        channel: input.channel,
        ok: delivery.ok,
        provider: delivery.provider,
        ...(delivery.detail ? { detail: delivery.detail } : {}),
      },
    });
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
          // ACTIVE 成员的 `subject` 是 SSO 主键（UUID），不是邮箱。
          // 成员表只拿到 membership，没有姓名/邮箱的副本；这里不把 UUID 交给前端，
          // 由前端用「我 / 已加入的同事」呈现。INVITED 的 subject 才是邮箱。
          email: item.subject.includes("@") ? item.subject : "",
          role: item.role,
          status: item.status === "INVITED" ? "INVITED" : "ACTIVE",
          url: null,
          expiresAt: null,
          createdAt: item.createdAt,
          delivery: null,
        })),
    });
  }

  /**
   * 撤销一条尚未接受的邀请。
   *
   * 门槛与 `invite()` 完全一致（能力表判定，服务端说了算，不信前端）：
   * 只有能邀请同事的人才能撤销邀请。删掉 membership 即让邀请票据失效，
   * `acceptInvite` 随后会给出「已被撤销」的 410。
   */
  async revokeInvite(actor: Membership, membershipId: string, actorName: string): Promise<void> {
    if (!hasCapability(actor, "member.invite")) {
      throw new TeamActionError("只有老板或主管可以撤销邀请", 403);
    }
    const parsed = EntityId.safeParse(membershipId);
    if (!parsed.success) {
      throw new TeamActionError("这条邀请不存在或已被撤销", 404);
    }
    const kernel = this.kernel();
    try {
      await kernel.tenancy.revokeMembership(actor.tenantId, parsed.data, {
        actor: { type: "HUMAN", id: actor.subject, role: actor.role },
        tenantId: actor.tenantId,
        correlationId: parsed.data,
      });
    } catch (error) {
      if (isKernelError(error)) {
        if (error.code === "RESOURCE_NOT_FOUND") {
          throw new TeamActionError("这条邀请不存在或已被撤销", 404);
        }
        if (error.code === "PERMISSION_DENIED") {
          throw new TeamActionError("只有老板或主管可以撤销邀请", 403);
        }
        throw new TeamActionError(error.message, 409);
      }
      throw error;
    }
    // 审计里只存 actorId（登录主体）；姓名是给人看的，记在日志便于排查。
    console.info(`[team] ${actorName} 撤销了邀请 ${membershipId}`);
  }

  async previewInvite(code: string, claims: AuthClaims): Promise<InvitePreview> {
    const ticket = this.ticket(code);
    if (ticket.kind !== "invite") throw new TeamActionError("这不是邀请链接", 400);
    const kernel = this.kernel();
    const tenant = await kernel.tenancy.findTenantBySlug(ticket.slug);
    if (!tenant) throw new TeamActionError("这间公司不存在或已停用", 410);
    const existing = await kernel.tenancy.findMembershipForTenant(claims.sub, tenant.id);
    // 邀请票据是无状态的：撤销即删 membership，票据本身仍然验签通过。
    // 所以这里必须回查「待接受的邀请」是否还在，否则撤销后的链接看起来仍然有效。
    const email = ticket.ownerEmail?.trim().toLowerCase() ?? "";
    if (!existing && (!email || !(await kernel.tenancy.findInvitedMembership(tenant.id, email)))) {
      throw new TeamActionError("这条邀请已被接受或已撤销，请让邀请人重新发一条", 410);
    }
    return InvitePreview.parse({
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      email: ticket.ownerEmail ?? "",
      role: ticket.role ?? "SALES",
      expiresAt: new Date(ticket.exp * 1000).toISOString(),
      alreadyMember: existing !== null,
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

    const existing = await kernel.tenancy.findMembershipForTenant(claims.sub, tenant.id);
    if (existing && existing.status === "ACTIVE") {
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
      delivery: null,
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
