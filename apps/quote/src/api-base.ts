/**
 * 客户报价页读取 API 的唯一入口。
 *
 * 这个值必须在**运行时**解析，不能靠 `next.config.ts` 的 rewrite 烤进产物：
 * rewrite 的 destination 在 `next build` 时就写进 `routes-manifest.json`，
 * 同一镜像跑不同环境（本地 / 测试 / 生产）时永远只能有一个目标，
 * 配错就表现为「所有链接都显示链接无效」。
 *
 * 生产漏配直接抛错而不是回落 `localhost:3000`：回落会把一次配置事故
 * 伪装成「客户拿到的是坏链接」，让客户去怀疑业务员、让人去查库查 token。
 */

const DEV_DEFAULT = "http://localhost:3000";

export class QuoteApiBaseMissingError extends Error {
  constructor() {
    super("QUOTE_API_BASE_URL 未配置：客户报价页无法访问后端 API");
    this.name = "QuoteApiBaseMissingError";
  }
}

export interface ApiBaseEnv {
  QUOTE_API_BASE_URL?: string | undefined;
  NODE_ENV?: string | undefined;
}

/**
 * 解析 API 根地址（不带尾部 `/`）。
 *
 * dev 允许回落本地 3000；生产必须显式配置，否则抛错由上层渲染成
 * 「服务暂时不可用」并在服务端日志里点名缺哪个变量。
 */
export function resolveQuoteApiBase(env: ApiBaseEnv = process.env): string {
  const configured = env.QUOTE_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (env.NODE_ENV === "production") throw new QuoteApiBaseMissingError();
  return DEV_DEFAULT;
}

/** 渲染侧用这个：把配置缺失降级成可读状态，而不是让整页 500。 */
export function tryResolveQuoteApiBase(
  env: ApiBaseEnv = process.env,
): { ok: true; base: string } | { ok: false; message: string } {
  try {
    return { ok: true, base: resolveQuoteApiBase(env) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "QUOTE_API_BASE_URL 未配置";
    console.error(`[quote] ${message}`);
    return { ok: false, message };
  }
}
