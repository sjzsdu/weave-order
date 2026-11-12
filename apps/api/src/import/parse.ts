import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import type { ImportBatch } from "@weave-order/schema";

/**
 * 导入文件的「输入适配器」：把 Excel/CSV 读成扁平字符串记录，再映射成
 * 内核可校验的行。这里**不写任何业务表、不连数据库** —— 目录边界由
 * `eslint.config.mjs` 的 no-restricted-imports 锁定（见 boundary.test）。
 *
 * 真正的逐行严格校验由内核用 `packages/schema` 契约完成（唯一来源），
 * 本模块只做「列 → 字段」的形状转换，坏值原样交给 Zod 判为 INVALID_INPUT。
 */

export type FlatRecord = Record<string, string>;

/** 客户文件的列名（其余列忽略）。 */
const CUSTOMER_COLUMNS = [
  "code",
  "name",
  "tier",
  "contactName",
  "contactPhone",
  "contactEmail",
] as const;
/** 样品文件的列名。costFloorAmount/costFloorCurrency 合成 costFloor 金额对象。 */
const SAMPLE_TEXT_COLUMNS = ["code", "name", "composition", "weight", "unit", "status"] as const;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  // 富文本 / 公式等复杂单元格：不猜测语义，交给契约按空值处理。
  return "";
}

/**
 * 读一个 CSV 或 XLSX 文件为「表头 → 字符串」记录数组。
 * CSV 用 csv-parse（支持引号 / BOM / 空行）；XLSX 用 exceljs（按 sheet 名或第一个工作表）。
 * 走文件路径而非 Buffer：exceljs 的 d.ts 把 Buffer 误声明为 ArrayBuffer 子类型，
 * `readFile(path)` 避开这个类型冲突，也更贴近冷启动读磁盘文件的真实用法。
 */
export async function readRecords(filePath: string, sheet?: string): Promise<FlatRecord[]> {
  if (/\.csv$/i.test(filePath)) {
    const content = await readFile(filePath);
    const raw: unknown = parse(content, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    return normalizeRecords(raw);
  }
  if (/\.xlsx$/i.test(filePath)) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = sheet ? workbook.getWorksheet(sheet) : workbook.worksheets[0];
    if (!worksheet) {
      throw new Error(`XLSX 缺少工作表：${sheet ?? "第一个工作表"}`);
    }
    return sheetRecords(worksheet);
  }
  throw new Error(`不支持的导入文件格式：${filePath}（仅支持 .csv / .xlsx）`);
}

function normalizeRecords(raw: unknown): FlatRecord[] {
  if (!Array.isArray(raw)) throw new Error("CSV 解析结果不是行数组");
  return raw.map((item: unknown): FlatRecord => {
    const record: FlatRecord = {};
    if (typeof item === "object" && item !== null) {
      for (const [key, value] of Object.entries(item)) {
        const cell: unknown = value;
        record[key] = typeof cell === "string" ? cell : cellText(cell);
      }
    }
    return record;
  });
}

function sheetRecords(worksheet: ExcelJS.Worksheet): FlatRecord[] {
  const headerRow = worksheet.getRow(1);
  const headerValues: readonly unknown[] = headerRow.values as unknown[];
  const headers: string[] = [];
  for (let col = 1; col < headerValues.length; col += 1) {
    headers.push(cellText(headerValues[col]));
  }

  const records: FlatRecord[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // 表头
    const record: FlatRecord = {};
    let hasValue = false;
    for (let col = 0; col < headers.length; col += 1) {
      const header = headers[col];
      if (!header) continue;
      const text = cellText(row.getCell(col + 1).value);
      record[header] = text;
      if (text !== "") hasValue = true;
    }
    if (hasValue) records.push(record);
  });
  return records;
}

/** 尝试把 JSON 单元格解析成对象；解析失败原样返回字符串，让契约判 INVALID_INPUT。 */
function jsonContextCell(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return value;
  }
}

/** 扁平客户记录 → 内核可校验的客户行（含可选私有上下文 context）。 */
export function toCustomerRow(record: FlatRecord): unknown {
  const row: Record<string, unknown> = {};
  for (const column of CUSTOMER_COLUMNS) {
    const value = record[column];
    if (value !== undefined && value !== "") row[column] = value;
  }
  const context = record["context"];
  if (context !== undefined && context !== "") row["context"] = jsonContextCell(context);
  return row;
}

/** 扁平样品记录 → 内核可校验的样品行（金额整数分由 Number 转换，坏值交 Zod 拒）。 */
export function toSampleRow(record: FlatRecord): unknown {
  const row: Record<string, unknown> = {};
  for (const column of SAMPLE_TEXT_COLUMNS) {
    const value = record[column];
    if (value !== undefined && value !== "") row[column] = value;
  }
  const amount = record["costFloorAmount"];
  if (amount !== undefined && amount !== "") {
    row["costFloor"] = {
      amount: Number(amount),
      currency: record["costFloorCurrency"] ?? undefined,
    };
  }
  return row;
}

/** 组装成 ImportBatch 信封（行内容仍是 unknown，由内核逐行严格校验）。 */
export function buildBatch(customers: FlatRecord[], samples: FlatRecord[]): ImportBatch {
  return {
    customers: customers.map(toCustomerRow),
    samples: samples.map(toSampleRow),
  };
}
