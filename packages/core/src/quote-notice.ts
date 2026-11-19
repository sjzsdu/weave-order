import { ApiError } from "./api-client";

/**
 * 报价链路的错误 → 面向业务员的提示。
 *
 * 为什么单独一层：工具失败是给机器读的（`KERNEL_REJECTED` + `PRICE_BELOW_COST_FLOOR`
 * +「0 < 200（分）」），直接贴到手机上既是整屏大字又不可操作。这里把 code/reason
 * 翻成「发生了什么 + 下一步点什么」，而且绝不透传内部单位（分、行号、策略名）。
 */

export interface QuoteNoticeAction {
  label: string;
  kind: "suggest-price";
}

export interface QuoteNotice {
  title: string;
  detail?: string;
  action?: QuoteNoticeAction;
}

/** 工具层失败的形状：`reason` 只有 KERNEL_REJECTED 才有，所以按可选字段接收。 */
export interface ToolFailureLike {
  code: string;
  message?: string;
  reason?: string;
}

export interface NoticeContext {
  /** 计价单位的中文名（米 / 公斤 / 码 / 件）。 */
  unitLabel?: string;
}

const suggestAction: QuoteNoticeAction = {
  label: "让报价助手建议单价",
  kind: "suggest-price",
};

/** 工具失败（T-004 / T-006）→ 可读提示。 */
export function quoteToolNotice(error: ToolFailureLike, ctx: NoticeContext = {}): QuoteNotice {
  switch (error.code) {
    case "KERNEL_REJECTED":
      return kernelNotice(error.reason, ctx);
    case "CUSTOMER_NOT_FOUND":
      return {
        title: "没找到这个客户",
        detail: "客户可能已被删除或不在你的数据范围内，请重新选择客户后再生成草稿。",
      };
    case "RESOURCE_NOT_FOUND":
      return {
        title: "没找到这块面料",
        detail: "面料可能已被删除，请回上一步重新找样。",
      };
    case "PERMISSION_DENIED":
      return {
        title: "当前账号没有报价权限",
        detail: "请让管理员开通报价权限，或把这条需求交给有权限的同事。",
      };
    case "INVALID_INPUT":
      return {
        title: "报价信息不完整",
        detail: "请检查客户、数量、单价是否都已填写。",
      };
    default:
      return {
        title: "没能生成报价草稿",
        detail: "请稍后重试；如果一直失败，把这条客户原话发给同事处理。",
      };
  }
}

function kernelNotice(reason: string | undefined, ctx: NoticeContext): QuoteNotice {
  switch (reason) {
    case "PRICE_BELOW_COST_FLOOR":
      return {
        title: "单价偏低，这单还不能生成草稿",
        detail:
          "当前单价低于公司成本底线。可以点下面的按钮让报价助手算一个合规价（回填后可再改），或把单价填高一些。",
        action: suggestAction,
      };
    case "UNIT_MISMATCH":
      return {
        title: "数量单位和这块面料不一致",
        detail: ctx.unitLabel
          ? `这块面料按${ctx.unitLabel}计价，请回上一步把计价单位改成${ctx.unitLabel}。`
          : "这块面料有固定的计价单位，请回上一步改好数量单位再试。",
      };
    case "COST_FLOOR_MISSING":
      return {
        title: "这块面料还没维护成本底线",
        detail: "没有成本底线的面料不能报价，请让管理员在样品库补齐成本，或换一块已维护的面料。",
      };
    case "CURRENCY_MISMATCH":
      return {
        title: "币种不一致，暂时不能核价",
        detail: "这块面料的成本币种和本次报价不同，请换一块面料或联系管理员。",
      };
    default:
      return {
        title: "内核没有通过这单报价",
        detail: "价格或数量不满足公司规则。可以让报价助手建议单价，或检查数量后重试。",
        action: suggestAction,
      };
  }
}

/** 网络 / HTTP 异常 → 可读提示；不展示原始 message（可能是英文异常或内部字段）。 */
export function requestNotice(error: unknown, fallbackTitle: string): QuoteNotice {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return { title: "登录已过期", detail: "请重新登录后再生成草稿。" };
    }
    if (error.status === 403) {
      return { title: "当前账号没有权限", detail: "请让管理员检查你的报价权限。" };
    }
    if (error.status >= 500) {
      return { title: "服务暂时不可用", detail: "请稍后重试；原话还留在页面上，不会丢。" };
    }
    return { title: fallbackTitle, detail: "请稍后再试；弱网时可以先存本地。" };
  }
  return { title: fallbackTitle, detail: "网络似乎不可用，已留在当前页面，恢复后可以重试。" };
}
