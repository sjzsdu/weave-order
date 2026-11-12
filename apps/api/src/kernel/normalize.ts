/**
 * 入参文本字段归一化。
 *
 * 界面录入最容易犯的错是「只敲了空格」：Zod 的 `min(1)` 会把 `"   "` 当成非空，
 * 于是产生一个名字为空白的客户/样品。先 trim 再交给契约校验，空串就会落到
 * 可读的「必填」错误上，而不是脏数据。
 */
export function trimTextFields(input: unknown, keys: readonly string[]): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const copy: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const key of keys) {
    const value = copy[key];
    if (typeof value === "string") copy[key] = value.trim();
  }
  return copy;
}
