import { z } from "zod";
import { DataScope, MemberRole } from "./tenancy";

/**
 * 开通链接（onboarding ticket）契约。
 *
 * 场景：平台管理员在控制台「开通公司」，生成一条链接发给客户老板；客户打开链接、
 * 用统一账号登录后，业务库才会真正建出这间公司（租户 + 老板成员）。
 *
 * 为什么用签名票据而不是直接用 slug：
 * - 业务库与控制面是两个库，`apps/api` 读不到控制面的租户记录，无法自行判断
 *   「这个 slug 是平台批过的」；
 * - 票据由平台侧用共享密钥签名，业务侧只验签，不依赖跨库查询；
 * - slug 可猜、可枚举，凭据不能开放匿名领取。
 *
 * 票据只携带建租户所需的最小信息，不放手机号、金额等敏感字段。
 */
export const OnboardingTicket = z
  .object({
    v: z.literal(1),
    /**
     * 票据用途：
     * - `tenant`：平台批过的公司，打开后建出公司（老板）。
     * - `invite`：公司里的老板/主管发给同事，打开后加入已有公司。
     */
    kind: z.enum(["tenant", "invite"]).default("tenant"),
    /** 公司标识，与控制面租户的 slug 一致；业务库租户用它做幂等键。 */
    slug: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    /** 公司名称，建租户时直接落库。 */
    name: z.string().min(1).max(255),
    /** 登记的联系人邮箱：登录邮箱不一致时拒绝领取（可为空，表示不校验）。 */
    ownerEmail: z.string().email().nullable(),
    /** 仅 `invite` 使用：加入后拿到的角色。 */
    role: MemberRole.nullable().default(null),
    /** 过期时间（Unix 秒）。 */
    exp: z.number().int().positive(),
  })
  .strict();
export type OnboardingTicket = z.infer<typeof OnboardingTicket>;

export const OnboardingClaimInput = z
  .object({
    code: z.string().min(20).max(4096),
  })
  .strict();
export type OnboardingClaimInput = z.infer<typeof OnboardingClaimInput>;

/** 打开链接后、真正领取前的预览：告诉用户「你将加入哪家公司」。 */
export const OnboardingPreview = z
  .object({
    slug: z.string(),
    name: z.string(),
    ownerEmail: z.string().nullable(),
    expiresAt: z.string(),
    /** 业务库是否已经建过这间公司。 */
    tenantExists: z.boolean(),
    /** 当前登录账号是否已经是这家公司的成员。 */
    membershipExists: z.boolean(),
  })
  .strict();
export type OnboardingPreview = z.infer<typeof OnboardingPreview>;

export const OnboardingResult = z
  .object({
    tenantId: z.string(),
    tenantSlug: z.string(),
    tenantName: z.string(),
    membershipId: z.string(),
    role: MemberRole,
    dataScope: DataScope,
    /** true = 这笔领取之前就已经是成员（重复点击 / 重复打开链接）。 */
    alreadyActivated: z.boolean(),
  })
  .strict();
export type OnboardingResult = z.infer<typeof OnboardingResult>;

/* ------------------------------------------------------------------ 自助开通 */

/**
 * 老板自助创建公司：登录后填个公司名就能开始用，不再等平台发链接。
 *
 * 仍受两条限制（服务端强制，不是界面自觉）：
 * 1. 一个账号只能属于一间公司（当前数据模型）；
 * 2. 一个账号只能开一次试用，重复调用返回既有的公司。
 */
export const StartTenantInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    /** 可读的公司标识；不填则按时间生成 `t-xxxxxxxx`。 */
    slug: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
  })
  .strict();
export type StartTenantInput = z.infer<typeof StartTenantInput>;

/** 邀请同事：只允许管理员/老板操作，角色不能是 OWNER（老板只能有一个入口：创建公司）。 */
export const InviteMemberInput = z
  .object({
    email: z.string().trim().email(),
    name: z.string().trim().max(255).optional(),
    role: MemberRole.exclude(["OWNER"]).default("SALES"),
    /** 通知方式：邮件（默认）或短信；短信需要同时给手机号。 */
    channel: z.enum(["email", "sms"]).default("email"),
    /** 选短信时必填，格式宽松校验（含国际区号也允许）。 */
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9][0-9 -]{5,19}$/)
      .optional(),
  })
  .strict();
export type InviteMemberInput = z.infer<typeof InviteMemberInput>;

export const TeamInvite = z
  .object({
    membershipId: z.string(),
    email: z.string(),
    role: MemberRole,
    status: z.enum(["INVITED", "ACTIVE"]),
    /** 生成新链接时返回；列表现有邀请不再回传明文链接。 */
    url: z.string().nullable(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
    /** 通知发送结果；列表现有邀请为 null。 */
    delivery: z
      .object({
        channel: z.enum(["email", "sms"]),
        ok: z.boolean(),
        provider: z.string(),
        detail: z.string().optional(),
      })
      .nullable(),
  })
  .strict();
export type TeamInvite = z.infer<typeof TeamInvite>;

export const TeamInviteList = z.object({ invites: z.array(TeamInvite) }).strict();
export type TeamInviteList = z.infer<typeof TeamInviteList>;

export const InvitePreview = z
  .object({
    tenantName: z.string(),
    tenantSlug: z.string(),
    email: z.string(),
    role: MemberRole,
    expiresAt: z.string(),
    /** 当前账号是否已经在这间公司里。 */
    alreadyMember: z.boolean(),
  })
  .strict();
export type InvitePreview = z.infer<typeof InvitePreview>;
