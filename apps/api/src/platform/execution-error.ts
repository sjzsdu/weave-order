/**
 * 基础设施异常（数据库、检查点初始化、进程装配）的人话兜底。
 *
 * 不能复用 `humanizeLlmError`：模型可能根本没被调用到，把原因说成
 * 「模型服务暂时不可用」会把排查方向带偏（WAN-180）。原始错误只进服务端日志。
 */
export const EXECUTION_FAILURE_REASON = "这次请求没能被正确处理，原话还在，可以重试。";

/** 报价 agent 在进入图之前就失败（组合根 / 检查点 / 数据库）时的失败节点。 */
export const EXECUTION_FAILURE_NODE = "bootstrap";
export const EXECUTION_FAILURE_CODE = "INFRASTRUCTURE";
