import type { QuoteDetail, QuoteDraft, QuoteStatus, SpecMatch, Unit } from "@weave-order/schema";

/**
 * 报价闭环协调器（ADR-3）。
 *
 * 为什么不引入 XState：整条链只有「前进一屏 / 回退一屏」，没有并行分支、
 * 没有跨会话持久化恢复。一个 discriminated union + 显式 `transition` 就够，
 * 而且能被单测逐条覆盖（见 test/quote-flow.test.ts）。
 *
 * 页面只做三件事：渲染当前 phase、把用户动作翻译成事件、把事件结果交给 API。
 * 任何「现在能不能批准 / 能不能生成草稿」的判断都留在这里，页面不重复写。
 */

export type QuotePhase =
  "input" | "parsing" | "candidates" | "draft" | "approving" | "approved" | "sharing";

/** 入口模式决定预填策略，不决定权限。 */
export type QuoteMode = "paste" | "camera" | "sample" | "customer" | "edit";

export const QUOTE_MODES: readonly QuoteMode[] = ["paste", "camera", "sample", "customer", "edit"];

export interface QuoteEntryParams {
  mode: QuoteMode;
  sampleId?: string;
  customerId?: string;
  quoteId?: string;
}

export interface QuoteFlowState {
  phase: QuotePhase;
  mode: QuoteMode;
  /** 从样品 / 相机进入时带进来的面料。 */
  sampleId: string | null;
  /** 改价入口带进来的报价单。 */
  quoteId: string | null;
  raw: string;
  /** null = 未选客户。绝不回落到客户列表第一条。 */
  customerId: string | null;
  quantity: string;
  unit: Unit;
  unitPrice: string;
  /** 「听懂了」的槽位，可被用户逐项改写。 */
  composition: string;
  weight: string;
  deliveryHint: string | null;
  matches: SpecMatch[];
  draft: QuoteDraft | null;
  version: number;
  status: QuoteStatus;
  shareUrl: string | null;
  shareError: string | null;
  /** 本次动作已入离线队列（compose / decide），页面据此提示「联网后提交」。 */
  offlineQueued: boolean;
  offlineNote: string | null;
  error: string | null;
  revisionNote: string | null;
  /** 空候选的两种原因，文案不同（索引未完成 ≠ 确实没有）。 */
  emptyReason: "INDEXING" | "NONE" | null;
}

export const INITIAL_QUOTE_STATE: QuoteFlowState = {
  phase: "input",
  mode: "paste",
  sampleId: null,
  quoteId: null,
  raw: "",
  customerId: null,
  quantity: "500",
  unit: "meter",
  unitPrice: "",
  composition: "",
  weight: "",
  deliveryHint: null,
  matches: [],
  draft: null,
  version: 1,
  status: "DRAFT",
  shareUrl: null,
  shareError: null,
  offlineQueued: false,
  offlineNote: null,
  error: null,
  revisionNote: null,
  emptyReason: null,
};

export type QuoteEvent =
  | { type: "enter"; params: QuoteEntryParams }
  | { type: "rawChanged"; raw: string }
  | { type: "customerSelected"; customerId: string }
  | { type: "quantityChanged"; quantity: string }
  | { type: "unitToggled" }
  | { type: "unitPriceChanged"; unitPrice: string }
  | { type: "parseStarted" }
  | {
      type: "parseSucceeded";
      matches: SpecMatch[];
      composition?: string | null;
      weight?: string | null;
      deliveryHint?: string | null;
      quantity?: { value: number; unit: Unit } | null;
      query?: string;
      emptyReason?: "INDEXING" | "NONE" | null;
    }
  | { type: "parseFailed"; error: string }
  | { type: "draftLoaded"; detail: QuoteDetail }
  | { type: "draftCreated"; draft: QuoteDraft; unitPrice: string }
  | { type: "samplePreset" }
  | { type: "approveStarted" }
  | { type: "approved" }
  | { type: "approvalFailed"; error: string }
  | { type: "shareReady"; url: string }
  | { type: "shareFailed"; error: string }
  | { type: "repriceApplied"; draft: QuoteDraft; version: number; note: string }
  | { type: "offlineQueued"; note: string }
  | { type: "approvalQueued"; note: string }
  | { type: "errorDismissed" }
  | { type: "back" }
  | { type: "reset" };

/**
 * 一次报价闭环里用户必须做的点击。测试用它守住「≤5 次点击」的验收线。
 */
export const QUOTE_CLICK_EVENTS: ReadonlySet<QuoteEvent["type"]> = new Set([
  "enter",
  "customerSelected",
  "parseStarted",
  "draftCreated",
  "approveStarted",
]);

function toQuantityText(value: number | null | undefined, current: string): string {
  return value != null && Number.isFinite(value) ? String(value) : current;
}

export function transition(state: QuoteFlowState, event: QuoteEvent): QuoteFlowState {
  switch (event.type) {
    case "enter": {
      const { params } = event;
      const mode = QUOTE_MODES.includes(params.mode) ? params.mode : "paste";
      return {
        ...INITIAL_QUOTE_STATE,
        mode,
        // 只有从客户页 / 样品页 / 改价入口进入才预填；其他入口一律「客户：未选」。
        customerId: mode === "customer" ? (params.customerId ?? null) : null,
        sampleId: params.sampleId ?? null,
        quoteId: params.quoteId ?? null,
        phase: mode === "edit" && params.quoteId ? "draft" : "input",
      };
    }

    case "rawChanged":
      return state.phase === "input" ? { ...state, raw: event.raw, error: null } : state;

    case "customerSelected":
      return { ...state, customerId: event.customerId, error: null };

    case "quantityChanged":
      return { ...state, quantity: event.quantity };

    case "unitToggled":
      return { ...state, unit: state.unit === "meter" ? "yard" : "meter" };

    case "unitPriceChanged":
      return { ...state, unitPrice: event.unitPrice, error: null };

    case "parseStarted":
      return { ...state, phase: "parsing", error: null };

    case "parseSucceeded": {
      if (state.phase !== "input" && state.phase !== "parsing" && state.phase !== "candidates") {
        return state;
      }
      // 候选中改成分 / 克重只更新槽位，不清掉已有的候选卡（用户按需重新找样）。
      const keepCandidates = state.phase === "candidates";
      return {
        ...state,
        phase: "candidates",
        matches: keepCandidates
          ? event.matches.length > 0
            ? event.matches
            : state.matches
          : event.matches,
        composition: event.composition ?? state.composition,
        weight: event.weight ?? state.weight,
        deliveryHint: event.deliveryHint ?? state.deliveryHint,
        quantity: toQuantityText(event.quantity?.value, state.quantity),
        unit: event.quantity?.unit ?? state.unit,
        emptyReason: event.emptyReason ?? (event.matches.length === 0 ? "NONE" : null),
        error: null,
      };
    }

    case "parseFailed":
      return { ...state, phase: "input", matches: [], error: event.error };

    case "draftLoaded":
      return {
        ...state,
        phase: "draft",
        draft: event.detail.draft,
        status: event.detail.status,
        version: event.detail.version,
        customerId: event.detail.draft.customerId,
        quoteId: event.detail.draft.id,
        error: null,
      };

    case "samplePreset":
      return state.sampleId ? { ...state, phase: "candidates", error: null } : state;

    case "draftCreated":
      return {
        ...state,
        phase: "draft",
        draft: event.draft,
        status: "DRAFT",
        version: event.draft.version,
        unitPrice: event.unitPrice,
        error: null,
        offlineQueued: false,
        offlineNote: null,
      };

    case "approveStarted":
      // 只有草稿态能批准；候选页 / 已批准状态重复点击一律忽略。
      return state.phase === "draft" ? { ...state, phase: "approving", error: null } : state;

    case "approved":
      return {
        ...state,
        phase: "approved",
        status: "SENT",
        offlineQueued: false,
        offlineNote: null,
      };

    case "approvalFailed":
      return { ...state, phase: state.draft ? "draft" : "input", error: event.error };

    case "shareReady":
      return { ...state, phase: "sharing", shareUrl: event.url, shareError: null };

    case "shareFailed":
      return { ...state, phase: "approved", shareError: event.error };

    case "repriceApplied":
      return {
        ...state,
        draft: event.draft,
        version: event.version,
        revisionNote: event.note,
      };

    case "offlineQueued":
      return { ...state, offlineQueued: true, offlineNote: event.note };

    case "approvalQueued":
      // 离线批准：回到草稿屏并明确「联网后再提交」，不能假装已批准。
      return {
        ...state,
        phase: "draft",
        offlineQueued: true,
        offlineNote: event.note,
        error: null,
      };

    case "errorDismissed":
      return { ...state, error: null };

    case "back":
      if (state.phase === "draft") return { ...state, phase: "candidates" };
      if (state.phase === "candidates") return { ...state, phase: "input" };
      return state;

    case "reset":
      return { ...INITIAL_QUOTE_STATE, mode: state.mode };

    default:
      return state;
  }
}

/** 生成草稿的硬门槛：客户必须先选；没选就拦住并给出可读原因。 */
export function missingForDraft(state: QuoteFlowState): string | null {
  if (!state.customerId) return "先选客户：报价必须归属一个客户，不会自动用第一个。";
  const quantity = Number(state.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return "数量要大于 0。";
  return null;
}

/** 找样用的检索词：用户改过的成分 / 克重优先。 */
export function searchQuery(state: QuoteFlowState): string {
  const parts = [state.composition, state.weight].map((part) => part.trim()).filter(Boolean);
  return parts.join(" ") || state.raw.trim().slice(0, 30);
}

export interface PrimaryAction {
  kind: "approve" | "submit" | "share" | "retry-share" | "none";
  label: string;
  hint: string;
}

/**
 * 草稿主按钮：有 quote.approve 能力才显示「批准并分享」。
 * 没有能力时不是把按钮藏起来，而是换成「提交审批」——
 * 草稿生成即进入审批队列（DRAFT 全量可见），提交无需额外写操作。
 */
export function primaryAction(
  state: QuoteFlowState,
  options: { canApprove: boolean },
): PrimaryAction {
  if (state.phase === "sharing" && state.shareUrl) {
    return { kind: "share", label: "复制链接", hint: "链接已生成，转发给客户即可。" };
  }
  if (state.phase === "approved") {
    return {
      kind: state.shareError ? "retry-share" : "none",
      label: state.shareError ? "重新生成链接" : "正在生成分享链接…",
      hint: state.shareError ?? "批准已生效，链接生成后自动复制。",
    };
  }
  if (options.canApprove) {
    return {
      kind: "approve",
      label: "批准并分享",
      hint: "批准后原地生成客户链接，不跳页。",
    };
  }
  return {
    kind: "submit",
    label: "提交审批",
    hint: "你没审批权：草稿会出现在有审批权同事的待办里。",
  };
}

/**
 * 路由参数 → 入口参数。
 *
 * 老入口可能只带 sampleId / customerId 不带 mode，这里按「带了什么就按什么进入」
 * 补齐，避免出现「带样品进来却停在空白输入页」的断链。
 */
export function entryParamsFromRoute(params: Record<string, string | undefined>): QuoteEntryParams {
  const rawMode = params.mode as QuoteMode | undefined;
  const inferred: QuoteMode =
    rawMode && QUOTE_MODES.includes(rawMode)
      ? rawMode
      : params.quoteId
        ? "edit"
        : params.sampleId
          ? "sample"
          : params.customerId
            ? "customer"
            : "paste";
  return {
    mode: inferred,
    ...(params.sampleId ? { sampleId: params.sampleId } : {}),
    ...(params.customerId ? { customerId: params.customerId } : {}),
    ...(params.quoteId ? { quoteId: params.quoteId } : {}),
  };
}
