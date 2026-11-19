/**
 * 报价槽位解析的唯一实现在 `@weave-order/core`（`quote-slots.ts`）。
 *
 * 桌面报价工作台与移动端 composer 共用同一套解析规则：复制一份到两端，
 * 迟早会出现「同一句客户原话，手机认得出客户、桌面认不出」。这里只保留
 * 旧导入路径，避免逐页改 import。
 */
export {
  centsToYuanInput,
  parseCustomerText,
  yuanInputToCents,
} from "@weave-order/core";
export type {
  ParseConfidence,
  ParseCustomerContext,
  ParsedSlots,
} from "@weave-order/core";
