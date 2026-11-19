/**
 * 报价错误提示的唯一实现已经沉到 `@weave-order/core`，桌面 composer 与
 * 移动端共用同一套「发生了什么 + 下一步点什么」的文案。
 */
export { quoteToolNotice, requestNotice } from "@weave-order/core";
export type {
  NoticeContext,
  QuoteNotice,
  QuoteNoticeAction,
  ToolFailureLike,
} from "@weave-order/core";
