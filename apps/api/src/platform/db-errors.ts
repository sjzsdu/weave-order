/**
 * 数据库结构缺口（缺表 / 缺列 / 缺函数）的识别。
 *
 * 生产上「发布漏跑迁移」不会在构建期暴露：代码起来了，只有碰到新表的那条查询
 * 才 500。用户看到的是 `Internal server error`，没人知道该去跑 migrate。
 * 这里把 PG 的错误码翻成一次可执行的判断，交给 HTTP 面回 503 + 人话。
 *
 * 只在无法继续的语义下使用：缺对象属于「服务暂时不可用」，不是客户端错误。
 */
const SCHEMA_GAP_CODES = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "42883", // undefined_function
  "3F000", // invalid_schema_name
]);

export interface SchemaGap {
  /** PG 错误码，例如 42P01。 */
  code: string;
  /** 缺失对象名（能解析出来才有），用于给运维定位。 */
  missing?: string;
}

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    chain.push(current);
    if (typeof current !== "object" || current === null) break;
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function missingTarget(message: string): string | undefined {
  const patterns = [
    // 缺列先判：`column "x" of relation "y" does not exist` 也能被下面的 relation 规则匹配上。
    /column "([^"]+)" of relation "[^"]+" does not exist/,
    /column "([^"]+)" does not exist/,
    /relation "([^"]+)" does not exist/,
    /function ([^(]+\((?:\s|,|[^)])*\)) does not exist/,
    /schema "([^"]+)" does not exist/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

/**
 * 沿 `cause` 链找第一条 PG 结构缺口。drizzle 会把 pg 错误包进 QueryFailedError，
 * 真正带 `code` 的那层通常在 2～3 层深处。
 */
export function findSchemaGap(error: unknown): SchemaGap | null {
  for (const link of causeChain(error)) {
    if (typeof link !== "object" || link === null) continue;
    const code = (link as { code?: unknown }).code;
    if (typeof code !== "string" || !SCHEMA_GAP_CODES.has(code)) continue;
    const message = (link as { message?: unknown }).message;
    const target = typeof message === "string" ? missingTarget(message) : undefined;
    return { code, ...(target ? { missing: target } : {}) };
  }
  return null;
}

/** 给人看的一句话：说清「能修」而不是只报错。 */
export function schemaGapMessage(gap: SchemaGap): string {
  const what = gap.missing ? `（缺少 ${gap.missing}）` : "";
  return `服务暂时不可用：数据库还没升级到当前版本${what}。需要管理员执行数据库迁移后重试，这不是你的操作问题。`;
}
