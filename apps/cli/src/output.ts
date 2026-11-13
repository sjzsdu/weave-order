/** 输出：默认给人看（表格 / 文案），`--json` 给 agent 看（可直接解析）。 */

export function isJsonMode(json: boolean): boolean {
  return json;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printLine(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function printError(message: string): void {
  process.stderr.write(`${message}\n`);
}

export interface Column<T> {
  header: string;
  value: (row: T) => string;
}

function displayWidth(text: string): number {
  // 粗略宽度：CJK 字符占两列，够表格对齐用。
  let width = 0;
  for (const char of text) {
    width += /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

export function printTable<T>(rows: T[], columns: Column<T>[]): void {
  if (rows.length === 0) {
    printLine("（没有数据）");
    return;
  }
  const widths = columns.map((column) =>
    Math.max(displayWidth(column.header), ...rows.map((row) => displayWidth(column.value(row)))),
  );
  printLine(columns.map((column, index) => pad(column.header, widths[index] ?? 0)).join("  "));
  printLine(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    printLine(
      columns.map((column, index) => pad(column.value(row), widths[index] ?? 0)).join("  "),
    );
  }
}

export function shortTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}
