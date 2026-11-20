import { z } from "zod";

/**
 * 路由入口参数的契约（纯逻辑，不依赖 Taro，便于单测）。
 *
 * 页面组件不关心「自己是 tab 还是二级页」，只从这里拿已经校验过的入口参数；
 * 新增入口只加一个调用点，不再新增 `openXxx` 函数。
 */

/** 路由 id 参数：UUID / 短编号都放行，空串视为未传。 */
const idParam = z.string().trim().min(1).max(128);
const optionalId = idParam.optional();

export const QUOTE_MODES = ["paste", "camera", "sample", "customer", "edit"] as const;
export type QuoteMode = (typeof QUOTE_MODES)[number];

/**
 * 报价入口：`mode` 决定预填什么，不决定权限。
 *
 * - `paste`    贴一段客户原话（默认）
 * - `camera`   从相机找样进来
 * - `sample`   带样品（`sampleId` 必填）
 * - `customer` 带客户（`customerId` 必填）
 * - `edit`     改一张已有草稿（`quoteId` 必填）
 *
 * `paste` 允许同时带样品或客户：相机找样、客户行的「快速报价」都是这一种。
 */
export const quoteEntrySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("paste"), sampleId: optionalId, customerId: optionalId }),
  z.object({ mode: z.literal("camera"), customerId: optionalId }),
  z.object({ mode: z.literal("sample"), sampleId: idParam, customerId: optionalId }),
  z.object({ mode: z.literal("customer"), customerId: idParam }),
  z.object({ mode: z.literal("edit"), quoteId: idParam }),
]);

/**
 * 页面消费的扁平形状：校验通过后，缺失字段就是「没有」，页面不再按 mode 收窄。
 * （校验仍然由上面的 discriminated union 负责：`edit` 缺 `quoteId` 进不来。）
 */
export interface QuoteEntryParams {
  mode: QuoteMode;
  sampleId?: string;
  customerId?: string;
  quoteId?: string;
}

function toEntry(candidate: Record<string, unknown>, mode: QuoteMode): QuoteEntryParams {
  const entry: QuoteEntryParams = { mode };
  if (typeof candidate.sampleId === "string" && candidate.sampleId)
    entry.sampleId = candidate.sampleId;
  if (typeof candidate.customerId === "string" && candidate.customerId) {
    entry.customerId = candidate.customerId;
  }
  if (typeof candidate.quoteId === "string" && candidate.quoteId) entry.quoteId = candidate.quoteId;
  return entry;
}

/**
 * 相机入口模式。WAN-185 会把每个 mode 的字段（品名 / 成分 / 运单号）收进各自的
 * 分支，这里先固定取值集合，页面不用再自己猜字符串。
 */
export const CAMERA_MODES = [
  "find",
  "waybill",
  "sample",
  "signature",
  "cargo",
  "receipt",
  "bizcard",
  "fabric",
  "label",
] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];

export const cameraEntrySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("find") }),
  z.object({ mode: z.literal("waybill") }),
  z.object({ mode: z.literal("sample") }),
  z.object({ mode: z.literal("signature") }),
  z.object({ mode: z.literal("cargo") }),
  z.object({ mode: z.literal("receipt") }),
  z.object({ mode: z.literal("bizcard") }),
  z.object({ mode: z.literal("fabric") }),
  z.object({ mode: z.literal("label") }),
]);
export type CameraEntryParams = z.infer<typeof cameraEntrySchema>;

export const DEFAULT_QUOTE_ENTRY: QuoteEntryParams = { mode: "paste" };

/** 深链 query → 入口参数；不合法时退回默认入口，不把半截参数带进页面。 */
export function parseQuoteEntryQuery(query: Record<string, string | undefined>): QuoteEntryParams {
  const candidate = {
    mode: query.mode ?? "paste",
    sampleId: query.sampleId,
    customerId: query.customerId,
    quoteId: query.quoteId,
  };
  const parsed = quoteEntrySchema.safeParse(candidate);
  if (!parsed.success) return DEFAULT_QUOTE_ENTRY;
  return toEntry(candidate, parsed.data.mode);
}

/** 入口参数合法则原样返回（扁平形状），否则 null。 */
export function parseQuoteEntry(value: unknown): QuoteEntryParams | null {
  const parsed = quoteEntrySchema.safeParse(value);
  if (!parsed.success) return null;
  return toEntry(value as Record<string, unknown>, parsed.data.mode);
}

/**
 * 入口参数的唯一解析入口：本地暂存优先（tab 页不能带 query），其次深链 query。
 * 暂存值同样过一遍 Zod —— 本地存储不归页面管，不能假设它是干净的。
 */
export function resolveQuoteEntry(
  stored: unknown,
  query: Record<string, string | undefined> = {},
): QuoteEntryParams {
  return parseQuoteEntry(stored) ?? parseQuoteEntryQuery(query);
}

/** 暂存值的来源：一次 `take` 取走一份，没有则为 null（不返回默认值）。 */
export interface QuoteEntrySource {
  take(): unknown;
}

export interface QuoteEntrySession {
  /** 首挂载：只消费一次并记住结果，之后重复调用返回同一份入口。 */
  mount(query?: Record<string, string | undefined>): QuoteEntryParams;
  /** 页面再次显示：只有确实有新入口时才返回，否则 null（点 tabbar 不该重置页面）。 */
  resume(query?: Record<string, string | undefined>): QuoteEntryParams | null;
}

/**
 * 入口参数的「一次消费」状态机。
 *
 * Taro 的首屏时序是 `useDidShow` 先于挂载 effect：两处各自去读暂存值，就会
 * 一处拿到 edit、另一处拿到默认 paste 并覆盖它（WAN-183 第 2 轮 FAIL 的原因）。
 * 这里把消费点收敛成一份显式状态 —— 挂载固定读第一次，show 之后只在有新入口时返回。
 */
export function createQuoteEntrySession(source: QuoteEntrySource): QuoteEntrySession {
  let mounted: QuoteEntryParams | null = null;
  return {
    mount(query = {}) {
      if (!mounted) mounted = resolveQuoteEntry(source.take(), query);
      return mounted;
    },
    resume(query = {}) {
      const stored = source.take();
      if (stored === null) return null;
      return resolveQuoteEntry(stored, query);
    },
  };
}

export function parseCameraMode(value: unknown): CameraMode | null {
  const parsed = z.enum(CAMERA_MODES).safeParse(value);
  return parsed.success ? parsed.data : null;
}
