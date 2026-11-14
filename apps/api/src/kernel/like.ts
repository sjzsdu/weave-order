/**
 * 把用户输入里的 LIKE 元字符转义成字面量。
 * `%` / `_` 是通配符，`\` 是转义符本身；三层顺序不能反，否则会双重转义。
 *
 * 单独成文件供 samples / search / sample-index 共用，避免三处各写一份后语义漂移
 * （尤其是语义分支的 composition 过滤曾经漏了转义）。
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
