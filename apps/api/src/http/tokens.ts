/** Nest 依赖注入 token：内核、工具、审批服务（控制器拿不到数据库句柄）。 */
export const KERNEL = Symbol("WEAVE_KERNEL");
export const TOOLS = Symbol("WEAVE_TOOLS");
export const HUMAN_ACTOR = Symbol("WEAVE_HUMAN_ACTOR");

export const QUOTE_AGENT = Symbol("QUOTE_AGENT");
export const PUBLIC_SHARE = Symbol("WEAVE_PUBLIC_SHARE");
export const PUBLIC_RATE_LIMIT = Symbol("WEAVE_PUBLIC_RATE_LIMIT");
