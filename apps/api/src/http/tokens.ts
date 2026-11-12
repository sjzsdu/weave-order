/** Nest 依赖注入 token：内核、工具、审批服务（控制器拿不到数据库句柄）。 */
export const KERNEL = Symbol("WEAVE_KERNEL");
export const TOOLS = Symbol("WEAVE_TOOLS");
export const APPROVAL = Symbol("WEAVE_APPROVAL");
