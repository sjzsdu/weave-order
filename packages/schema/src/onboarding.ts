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
    /**
     * 仅 `invite` 使用：这条邀请对应的成员行（`INVITED`）。
     *
     * 票据是无状态的，撤销不会改动已发出去的链接；把成员行 id 钉在票据里，
     * 预览时才能确认「被撤销的那一条」确实失效，而不会因为同邮箱被重新邀请
     * 就让旧链接复活。缺省（老票据）时回退到按邮箱查待接受邀请。
     */
    membershipId: z.string().min(1).max(64).optional(),
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
    /** 展示名（来自登录 claims）；邀请尚未接受时为空。 */
    displayName: z.string().nullable().optional(),
    /** 数据范围：只在成员与权限分栏里编辑。 */
    dataScope: DataScope.optional(),
    /** 审批金额上限（整数分）；null = 按角色默认规则。 */
    approvalLimitAmount: z.number().int().nonnegative().nullable().optional(),
    /** 是不是当前登录成员本人；本人行不允许改自己的角色（防自锁）。 */
    isSelf: z.boolean().optional(),
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

/**
 * 开张清单（新公司四步引导）的步骤键。
 *
 * 键序即产品顺序；服务端按这个顺序判断「全部完成」，前端不再自己维护第二份。
 */
export const OnboardingStepKey = z.enum(["customer", "sample", "quote", "approve"]);
export type OnboardingStepKey = z.infer<typeof OnboardingStepKey>;

/** 四步的稳定顺序；服务端判断「全部完成」时用它，不依赖对象键序。 */
export const ONBOARDING_STEP_KEYS = ["customer", "sample", "quote", "approve"] as const;

/**
 * 开张进度（`GET /api/onboarding/state`）。
 *
 * 为什么落库而不是只放浏览器：issue 要求「换设备进度一致」。
 * 哪些步骤已完成仍然由业务事实派生（客户数/样品数/报价数/已批单数），
 * 这里只持久化**服务器观察到完成的时间**与用户的收起/跳过偏好——
 * 换一台设备打开，勾与时间都对得上，也不会因为换设备就把引导重新弹一遍。
 */
export const OnboardingState = z
  .object({
    /**
     * 观察到的首次完成时间；没完成的步骤不出现，不编造历史。
     * 四个键显式声明而不是 record：接口契约要能看出「一共就这四步」。
     */
    completedAt: z
      .object({
        customer: z.string().datetime().optional(),
        sample: z.string().datetime().optional(),
        quote: z.string().datetime().optional(),
        approve: z.string().datetime().optional(),
      })
      .strict(),
    /** 用户收起了完整清单，只保留一行折叠条。 */
    collapsed: z.boolean(),
    /** 用户跳过了整张清单。 */
    skipped: z.boolean(),
    /** 四步全部完成的时间；未全部完成时为 null。 */
    allDoneAt: z.string().datetime().nullable(),
    /** 从未保存过时为 null：客户端据此知道这是默认值而不是真实进度。 */
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type OnboardingState = z.infer<typeof OnboardingState>;

/**
 * 更新开张进度（`PUT /api/onboarding/state`）。
 *
 * 只允许上报「这几步现在完成了」而不是直接写时间：
 * 时间戳由服务器生成，客户端时钟不可信；重复上报同一键不会覆盖首次时间。
 * 全部字段可选，收敛成「只改用户真正动过的那一项」。
 */
export const UpdateOnboardingStateInput = z
  .object({
    collapsed: z.boolean().optional(),
    skipped: z.boolean().optional(),
    /** 本次观察到已完成的步骤（来自 panorama 统计）。 */
    completeSteps: z.array(OnboardingStepKey).max(4).optional(),
  })
  .strict();
export type UpdateOnboardingStateInput = z.infer<typeof UpdateOnboardingStateInput>;

/**
 * 成员与权限分栏的编辑入参（WAN-175）。
 *
 * 三个字段都可单独修改；全部缺省视为空操作由服务端拒绝，而不是静默成功。
 * 角色变更会改变能力集合，因此服务端额外校验「不能改 OWNER」「不能改自己」。
 */
export const UpdateTeamMemberInput = z
  .object({
    role: MemberRole.optional(),
    dataScope: DataScope.optional(),
    approvalLimitAmount: z.number().int().nonnegative().nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.role !== undefined ||
      value.dataScope !== undefined ||
      value.approvalLimitAmount !== undefined,
    { message: "至少要修改一项：角色 / 数据范围 / 审批额度" },
  );
export type UpdateTeamMemberInput = z.infer<typeof UpdateTeamMemberInput>;
