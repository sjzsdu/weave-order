import { z } from "zod";
import {
  Currency,
  EntityId,
  FabricSample,
  Money,
  Quantity,
  QuoteStatus,
  Timestamp,
} from "./domain";
import { LlmTask } from "./llm";
import { RevisionDiff } from "./revisions";
import { ImagePayload } from "./tools/t001-search-fabric-by-image";
import { QuotePricingBasis } from "./tools/t006-suggest-line-price";
import { QuoteDraft } from "./tools/t004-generate-quote-draft";

/**
 * 找样 / 报价智能体的公共契约。
 *
 * 约束（铁律 G2 / G9 / G10）：
 * - agent 只调 tools；这里只有状态与建议，没有任何写账本字段。
 * - 草稿永远 DRAFT；金额由内核计算，pricingBasis 只引用内核结果。
 * - 对外模型只发脱敏后的文本与槽位，不发客户名单 / 成本底线。
 */

export const QuotingStage = z.enum([
  "NEW",
  "INTENT_PARSED",
  "SAMPLES_FOUND",
  "PRICED",
  "DRAFTED",
  "NEEDS_INPUT",
  "DONE",
  "FAILED",
]);
export type QuotingStage = z.infer<typeof QuotingStage>;

export const MissingFieldCode = z.enum([
  "CUSTOMER",
  "SAMPLE",
  "QUANTITY",
  "COMPOSITION",
  "WEIGHT",
  "PRICE",
  "CURRENCY",
]);
export type MissingFieldCode = z.infer<typeof MissingFieldCode>;

export const MissingField = z
  .object({
    code: MissingFieldCode,
    label: z.string().min(1).max(64),
    prompt: z.string().min(1).max(255),
    /** true = 缺少它就无法出草稿；false = 可以先出草稿再补。 */
    blocking: z.boolean(),
  })
  .strict();
export type MissingField = z.infer<typeof MissingField>;

/** LLM 从客户原话里抽取的槽位；数字单位仍由确定性代码归一。 */
export const QuoteIntentSlots = z
  .object({
    productKeywords: z.array(z.string().min(1).max(64)).max(20),
    composition: z.string().max(100).nullable(),
    weight: z.string().max(64).nullable(),
    quantity: Quantity.nullable(),
    priceRequested: z.boolean(),
    deliveryDate: z.string().max(64).nullable(),
  })
  .strict();
export type QuoteIntentSlots = z.infer<typeof QuoteIntentSlots>;

export const QuoteIntentExtraction = z
  .object({
    slots: QuoteIntentSlots,
    confidence: z.number().min(0).max(1),
    provider: z.string().min(1).max(64),
  })
  .strict();
export type QuoteIntentExtraction = z.infer<typeof QuoteIntentExtraction>;

/** 客户原话入口：text 是用户粘贴的原文，可选带图（以图找样）。 */
export const QuoteRequestInput = z
  .object({
    threadId: z.string().min(1).max(128).optional(),
    rawText: z.string().min(1).max(4000),
    /** 工作台当前选中的客户；没有时 agent 明确列为缺失项，不猜。 */
    customerId: EntityId.optional(),
    currency: Currency.default("CNY"),
    /** 旧路径：base64 图像（脚本/内部专用，移动端禁止）。 */
    image: ImagePayload.optional(),
    /** 移动端直传后的预签名 URL；与 image 二选一。 */
    imageUrl: z.string().url().max(2048).optional(),
    topK: z.number().int().positive().max(10).default(3),
  })
  .strict()
  .refine((value) => !(value.image && value.imageUrl), {
    message: "image 与 imageUrl 只能二选一",
    path: ["imageUrl"],
  });
export type QuoteRequestInput = z.infer<typeof QuoteRequestInput>;

export const CandidateSource = z.enum(["SPEC", "IMAGE", "COMBINED"]);
export type CandidateSource = z.infer<typeof CandidateSource>;

/** 一条候选样品 + 可解释的命中理由（理由来自确定性字段，不让 LLM 编）。 */
export const QuoteSampleCandidate = z
  .object({
    sample: FabricSample,
    score: z.number().min(0).max(1),
    matchedOn: z.array(z.string().max(64)).max(10),
    source: CandidateSource,
    rationale: z.string().min(1).max(500),
  })
  .strict();
export type QuoteSampleCandidate = z.infer<typeof QuoteSampleCandidate>;

/** 报价 agent 的业务失败：停在哪一步、什么错误码，不伪造成功。 */
export const QuoteAgentFailure = z
  .object({
    node: z.string().min(1).max(64),
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(500),
    stage: QuotingStage,
  })
  .strict();
export type QuoteAgentFailure = z.infer<typeof QuoteAgentFailure>;

/** 一次模型调用的用量回执（agent 透传给前端做「已记账」提示）。 */
export const LlmCallReceipt = z
  .object({
    requestId: z.string().uuid(),
    task: LlmTask,
    model: z.string(),
    provider: z.string(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
  })
  .strict();
export type LlmCallReceipt = z.infer<typeof LlmCallReceipt>;

/**
 * 找样/报价 agent 的最终产物。
 * status = NEEDS_INPUT 时 draft 为 null，missingFields 告诉用户还差什么；
 * status = DRAFTED 时 draft.status 恒为 DRAFT，人类确认后才可能 SENT。
 */
export const QuoteAgentResult = z
  .object({
    threadId: z.string(),
    stage: QuotingStage,
    status: z.enum(["DRAFTED", "NEEDS_INPUT", "FAILED"]),
    intent: QuoteIntentExtraction.nullable(),
    candidates: z.array(QuoteSampleCandidate).max(10),
    selectedSampleId: EntityId.nullable(),
    pricingBasis: QuotePricingBasis.nullable(),
    draft: QuoteDraft.nullable(),
    missingFields: z.array(MissingField).max(20),
    explanation: z.string().max(2000),
    /**
     * 降级说明：模型网关不可用、本次改用本地规则时给出人话原因。
     * 正常走企业模型时恒为 null；不得把网关原文 / request id 放进这里。
     */
    notice: z.string().max(500).nullable(),
    provider: z.string().min(1).max(64),
    usage: LlmCallReceipt.nullable(),
    failure: QuoteAgentFailure.nullable(),
  })
  .strict();
export type QuoteAgentResult = z.infer<typeof QuoteAgentResult>;

/**
 * 单据详情（只读 HTTP 契约）：草稿本体 + 生命周期状态。
 *
 * `QuoteDraft.status` 按 T-004 恒为 DRAFT，批准 / 发送之后的真实状态只能靠这里的
 * `status` 表达 —— 少了它，客户端读到一个「永远 DRAFT 的已批准报价单」。
 */
export const QuoteDetail = z
  .object({
    draft: QuoteDraft,
    version: z.number().int().positive(),
    status: QuoteStatus,
    /** 所属业务事项；历史报价（WAN-197 之前）没有关联，为 null。 */
    itemId: EntityId.nullable().default(null),
    /** 展示用编号（`BJ-YYYYMMDD-XXXX`），由内核按创建时间与 id 派生。 */
    quoteNumber: z.string().min(1).max(64).optional(),
    /** 确认人审计：谁在什么时候把价格定稿。 */
    confirmedBy: z.string().min(1).max(128).nullable().default(null),
    /** 确认人的可展示姓名；确认人已离开公司或未同步姓名时为 null。 */
    confirmedByName: z.string().min(1).max(128).nullable().default(null),
    confirmedAt: Timestamp.nullable().default(null),
    /** 智能体原稿总额：改价后仍保留，依据抽屉用它展示「原价」。 */
    baselineTotal: Money.nullable().default(null),
    /** 当前版本相对原稿的逐行 diff。 */
    pendingDiff: z.array(RevisionDiff).default([]),
  })
  .strict();
export type QuoteDetail = z.infer<typeof QuoteDetail>;

/**
 * 报价工作台列表项（WAN-175）。
 *
 * 列表只带「一眼判断该点哪一条」的字段：客户名、状态、金额、行数、有效期。
 * 逐行明细与改稿 diff 留在 `GET /api/quotes/:id` / 审批卡里懒加载，
 * 避免列表页为 50 条报价各拉一次明细。
 */
export const QuoteListItem = z
  .object({
    id: EntityId,
    customerId: EntityId,
    /** 客户名是列表现场 join 出来的展示快照；客户改名后列表立即跟随。 */
    customerName: z.string().min(1).max(255),
    status: QuoteStatus,
    currency: Currency,
    total: Money,
    version: z.number().int().positive(),
    itemCount: z.number().int().nonnegative(),
    /** 与草稿同一个有效期口径；已过期的历史报价仍可读。 */
    expiresAt: Timestamp,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    /** 是否还停在草稿态（需要走审批才会发送）。 */
    pendingApproval: z.boolean(),
  })
  .strict();
export type QuoteListItem = z.infer<typeof QuoteListItem>;

export const QuoteListResponse = z
  .object({
    items: z.array(QuoteListItem),
    /** 没有下一页时为 null。 */
    nextCursor: z.string().nullable(),
  })
  .strict();
export type QuoteListResponse = z.infer<typeof QuoteListResponse>;

/** 工作台列表筛选。`status` 缺省 = 全部状态。 */
export const QuoteListFilter = z
  .object({
    status: QuoteStatus.optional(),
    /** 客户名 / 报价单号前缀以外的自由关键词，只匹配客户名与样品描述。 */
    query: z.string().trim().max(200).optional(),
    customerId: EntityId.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().max(512).optional(),
  })
  .strict();
export type QuoteListFilter = z.infer<typeof QuoteListFilter>;
