/** Nest 依赖注入 token：内核、审批服务（控制器拿不到数据库句柄）。 */
export const KERNEL = Symbol("WEAVE_KERNEL");
export const HUMAN_ACTOR = Symbol("WEAVE_HUMAN_ACTOR");
/** 工具调用身份：PAT 的 write 作用域与驱动者审计从这里注入。 */
export const AGENT_ACTOR = Symbol("WEAVE_AGENT_ACTOR");

export const QUOTE_AGENT = Symbol("QUOTE_AGENT");
export const PUBLIC_SHARE = Symbol("WEAVE_PUBLIC_SHARE");
export const PUBLIC_RATE_LIMIT = Symbol("WEAVE_PUBLIC_RATE_LIMIT");
/** 样卡扫码公开面（无登录）：只回样品编号与业务员联系方式。 */
export const PUBLIC_SAMPLE = Symbol("WEAVE_PUBLIC_SAMPLE");
/** 图片上传编排（presign / confirm）：对象存储句柄不暴露到控制器。 */
export const MEDIA_SERVICE = Symbol("WEAVE_MEDIA_SERVICE");
