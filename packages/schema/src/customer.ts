import { z } from "zod";
import { CustomerContact } from "./contact";
import { Customer, CustomerContext, CustomerTierCode, EntityId, Money, Timestamp } from "./domain";

/**
 * 客户 360 读模型。
 *
 * 数字口径只在这里定义一次：PC 客户列表、桌面 360、移动端 360 都读同一组
 * 聚合字段，避免「列表 3 个在途、详情 5 个」这种各算各的。
 */

/** 列表筛选。`owner` 只是收窄可见范围（权限由 data-scope 决定），不是权限本身。 */
export const CustomerListOptions = z
  .object({
    /** 名称 / 编号 / 联系人 模糊搜索（字面量匹配）。 */
    query: z.string().trim().min(1).max(100).optional(),
    owner: z.enum(["mine", "all"]).optional(),
    /** 等级 code（不是 label）；筛选项来自 `field_options(customer.tier)`。 */
    tier: CustomerTierCode.optional(),
    overdueOnly: z.boolean().optional(),
    /**
     * `followup`：待跟进优先（有未决报价或逾期应收）→ 最近往来倒序 → 等级。
     * `recent` / 不传：保持原有「新建倒序」，供旧调用方使用。
     * 排序只在服务端做：前端拿到什么顺序就显示什么顺序，不再二次排序。
     */
    sort: z.enum(["recent", "followup"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export type CustomerListOptions = z.infer<typeof CustomerListOptions>;

/** 应收余额按币种拆开：跨币种不能直接相加。 */
export const MoneyByCurrency = z.array(Money);
export type MoneyByCurrency = z.infer<typeof MoneyByCurrency>;

/**
 * 客户列表一行 = 客户档案 + 负责人 + 四个聚合数字。
 * 每个数字都由后端聚合，前端只格式化。
 */
export const CustomerListItem = Customer.extend({
  ownerId: EntityId.nullable(),
  ownerName: z.string().nullable(),
  /** 未决报价：status = DRAFT。 */
  pendingQuoteCount: z.number().int().nonnegative(),
  /** 未决报价金额（DRAFT 合计），按币种分组；列表「未决金额」直接读它。 */
  pendingQuoteAmount: MoneyByCurrency,
  /** 在途寄样：CONFIRMED / SHIPPED（已确认但未签收）。 */
  inTransitSampleCount: z.number().int().nonnegative(),
  /** 有效订单：非 DRAFT / CANCELLED。 */
  activeOrderCount: z.number().int().nonnegative(),
  /** 未收余额（应收 - 已收），按币种分组。 */
  receivableBalance: MoneyByCurrency,
  /** 逾期应收笔数：未付且已过到期日。 */
  overdueReceivableCount: z.number().int().nonnegative(),
  /** 最近往来：报价 / 寄样 / 订单里最新的一次；没有真实往来为 null。 */
  lastContactAt: Timestamp.nullable(),
  /** 主联系人微信；点「微信」时复制，列表不展示完整号码以外的东西。 */
  contactWechat: z.string().max(255).nullable(),
}).strict();
export type CustomerListItem = z.infer<typeof CustomerListItem>;

/** 客户 360 的数字面板（与列表同一口径，可单独读取）。 */
export const CustomerSummary = z
  .object({
    customerId: EntityId,
    pendingQuoteCount: z.number().int().nonnegative(),
    inTransitSampleCount: z.number().int().nonnegative(),
    activeOrderCount: z.number().int().nonnegative(),
    receivableBalance: MoneyByCurrency,
    overdueReceivableCount: z.number().int().nonnegative(),
    /** 最近一张已发出（SENT）的报价；分享快捷动作据此可用，不受时间线分页影响。 */
    latestShareableQuoteId: EntityId.nullable(),
    lastContactAt: Timestamp.nullable(),
  })
  .strict();
export type CustomerSummary = z.infer<typeof CustomerSummary>;

/**
 * 客户 360 首屏：档案 + 上下文 + 汇总 + 联系人。
 *
 * `contacts` 只含未归档联系人（`is_primary desc, created_at asc`），
 * `customer.contactName/phone/email` 是主联系人投影，保留给旧页面与打印。
 * VIEWER 拿到的手机 / 邮箱已由后端按能力掩码。
 * timeline 单独分页拉取。
 */
export const Customer360 = z
  .object({
    customer: Customer,
    ownerId: EntityId.nullable(),
    ownerName: z.string().nullable(),
    context: CustomerContext,
    summary: CustomerSummary,
    contacts: z.array(CustomerContact),
  })
  .strict();
export type Customer360 = z.infer<typeof Customer360>;

/**
 * 时间线条目类型。
 * 「跟进」仍取自客户审计流水；「客户回复」是手工录入的 `inbound_messages`
 * （粘贴文本 / 截图 OCR 后的文本），2026-11-14 拍板移除真实渠道接入后新增。
 */
export const CustomerTimelineKind = z.enum([
  "quote",
  "sample_shipment",
  "order",
  "receivable",
  "followup",
  "inbound_reply",
]);
export type CustomerTimelineKind = z.infer<typeof CustomerTimelineKind>;

/**
 * 时间线一条 = 一张源单据。
 * `sourceId` 是「点开要去哪张单据」的 id：回款指向所属订单，其余指向自己。
 */
export const CustomerTimelineEvent = z
  .object({
    id: z.string().min(1),
    kind: CustomerTimelineKind,
    refId: EntityId,
    sourceId: EntityId,
    /** 单据编号；跟进来为审计动作名。 */
    code: z.string().nullable(),
    status: z.string().min(1),
    amount: Money.nullable(),
    occurredAt: Timestamp,
  })
  .strict();
export type CustomerTimelineEvent = z.infer<typeof CustomerTimelineEvent>;

/** 时间线一页：游标翻页，前端只追加不重拉。 */
export const CustomerTimelinePage = z
  .object({
    events: z.array(CustomerTimelineEvent),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type CustomerTimelinePage = z.infer<typeof CustomerTimelinePage>;
