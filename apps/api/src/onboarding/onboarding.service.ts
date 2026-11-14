import { Inject, Injectable } from "@nestjs/common";
import { OnboardingPreview, OnboardingResult } from "@weave-order/schema";
import type { AuthClaims } from "@weave-order/schema";
import { createKernel } from "../kernel";
import type { KernelContext } from "../kernel";
import { DatabaseProvider } from "../platform/database.provider";
import { loadEnv } from "../platform/env";
import { OnboardingTicketError, verifyOnboardingTicket } from "./ticket";

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
}
