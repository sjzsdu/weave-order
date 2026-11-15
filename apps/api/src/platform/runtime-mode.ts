/**
 * 运行时「生产态」判定 —— 实现已收敛到 `@weave-order/schema`，web 与 api 共用同一份。
 *
 * 这里保留同名 re-export，是为了让 api 内部调用点（`./runtime-mode`）与既有测试
 * 不用逐个改路径；**不要再在这里写第二份实现**，否则 api 与 web 的判定会重新分叉。
 */
export { isProductionLike } from "@weave-order/schema";
export type { RuntimeModeInput } from "@weave-order/schema";
