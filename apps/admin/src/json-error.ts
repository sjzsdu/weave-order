/**
 * 把 JSON.parse 的英文原文（"Expected property name or '}' in JSON at position 1 (line 1 column 2)"）
 * 转成中文、带行列位置的提示。用户改 JSON 时需要知道「第几行第几列、缺什么」。
 */

type Position = { line: number; column: number };

/** 从 offset 计算 1 基的行列（JSON 解析器的 position 是 0 基字符偏移）。 */
export function locate(value: string, offset: number): Position {
  const safe = Math.max(0, Math.min(offset, value.length));
  const before = value.slice(0, safe);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

function reasonFor(message: string): string {
  if (/Unexpected end of JSON input/i.test(message)) return "内容提前结束，缺少 } 或 ]";
  if (/Expected property name|Expected double-quoted property name/i.test(message)) {
    return "属性名必须用英文双引号包裹";
  }
  if (/Expected ':' after property name/i.test(message)) return "属性名后缺少冒号";
  if (/Expected ',' or '}' after property value/i.test(message)) return "属性值后缺少逗号或 }";
  if (/Expected ',' or ']' after array element/i.test(message)) return "数组元素后缺少逗号或 ]";
  if (/Bad control character|Bad escaped character/i.test(message))
    return "字符串里有非法转义或控制字符";
  if (/Unexpected (token|non-whitespace character)/i.test(message)) return "出现无法识别的字符";
  if (/Unterminated string/i.test(message)) return "字符串缺少结尾的双引号";
  return "无法解析，请检查括号、引号和逗号是否配对";
}

/**
 * @example describeJsonError('{not json', new SyntaxError("Expected property name or '}' in JSON at position 1 (line 1 column 2)"))
 *          → "JSON 格式错误：第 1 行第 2 列 —— 属性名必须用英文双引号包裹"
 */
export function describeJsonError(value: string, cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  const columnHint = /line (\d+) column (\d+)/i.exec(message);
  const positionHint = /position (\d+)/i.exec(message);
  const position: Position | null = columnHint
    ? { line: Number(columnHint[1]), column: Number(columnHint[2]) }
    : positionHint
      ? locate(value, Number(positionHint[1]))
      : value.trim() === ""
        ? { line: 1, column: 1 }
        : null;
  const reason = value.trim() === "" ? "内容为空，请填写 JSON（例如 {}）" : reasonFor(message);
  if (!position) return `JSON 格式错误：${reason}`;
  return `JSON 格式错误：第 ${position.line} 行第 ${position.column} 列 —— ${reason}`;
}
