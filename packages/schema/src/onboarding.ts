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
