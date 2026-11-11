/** Nest 依赖注入 token：内核与工具（控制器拿不到数据库句柄）。 */
export const KERNEL = Symbol("WEAVE_KERNEL");
export const TOOLS = Symbol("WEAVE_TOOLS");
