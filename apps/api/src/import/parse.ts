import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import type { ImportBatch } from "@weave-order/schema";
import {
  parseWeightMeasurement,
  parseWidthMeasurement,
} from "@weave-order/schema";
import type {
  WeightMeasurement,
  WeightUnit,
  WidthMeasurement,
  WidthUnit,
} from "@weave-order/schema";

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
const SAMPLE_TEXT_COLUMNS = [
  "code",
  "name",
  "composition",
  "category",
  "color",
  "unit",
  "status",
] as const;

/** 表头别名 → 契约字段。中文表头与「克重(单位)」写法导入同一列。 */
const SAMPLE_HEADER_ALIASES: Record<string, string> = {
  code: "code",
  样品编号: "code",
  编号: "code",
  name: "name",
  品名: "name",
  样品名称: "name",
  名称: "name",
  composition: "composition",
  成分: "composition",
  category: "category",
  品类: "category",
  color: "color",
  colour: "color",
  颜色: "color",
  weight: "weight",
  克重: "weight",
  "克重(gsm)": "weight",
  "克重(g/m2)": "weight",
  "克重(g/m²)": "weight",
  "克重(g/㎡)": "weight",
  "克重（gsm）": "weight",
  "克重（g/m2）": "weight",
  "克重（g/m²）": "weight",
  "克重（g/㎡）": "weight",
  width: "width",
  门幅: "width",
  幅宽: "width",
  unit: "unit",
  单位: "unit",
  status: "status",
  状态: "status",
  costflooramount: "costFloorAmount",
  成本底线: "costFloorAmount",
  成本价: "costFloorAmount",
  costfloorcurrency: "costFloorCurrency",
  币种: "costFloorCurrency",
};

/**
 * 表头 → 契约字段。
 *
 * 克重 / 门幅的单位写在表头里（`克重(g/m²)`、`门幅(inch)`），所以这两列
 * 不能只做全等匹配：先看别名表，再按「表头里出现了克重/门幅字样」兜底。
 */
function matchSampleHeader(header: string): string | null {
  const direct = SAMPLE_HEADER_ALIASES[header] ?? SAMPLE_HEADER_ALIASES[header.toLowerCase()];
  if (direct) return direct;
  const normalized = header.normalize("NFKC").toLowerCase();
  if (normalized.includes("克重") || normalized.includes("weight")) return "weight";
  if (normalized.includes("门幅") || normalized.includes("幅宽") || normalized.includes("width")) {
    return "width";
  }
  return null;
}

/**
 * 表头里写了单位，单元格就可以是纯数字：`克重(g/m²)` 下的 `220` 认成 220 g/m²。
 * 只有表头没写单位时不认 —— 那正是「无单位纯数字」必须留空的边界。
 */
function weightUnitFromHeader(header: string): WeightUnit | null {
  const normalized = header.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  if (!normalized.includes("克重") && !normalized.includes("weight")) return null;
  if (normalized.includes("oz/yd2") || normalized.includes("oz")) return "oz";
  if (normalized.includes("kg/m2") || normalized.includes("kgm2") || normalized.includes("kg")) {
    return "kgm2";
  }
  if (normalized.includes("/m2") || normalized.includes("gsm")) return "gsm";
  return null;
}

/** 门幅单位来自表头：`门幅(cm)` / `门幅(inch)` / `门幅(m)`。 */
function widthUnitFromHeader(header: string): WidthUnit | null {
  const normalized = header.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  if (
    !normalized.includes("门幅") &&
    !normalized.includes("幅宽") &&
    !normalized.includes("width")
  ) {
    return null;
  }
  if (normalized.includes("inch") || normalized.includes("英寸")) return "in";
  if (normalized.includes("cm") || normalized.includes("厘米")) return "cm";
  if (normalized.includes("米") || /m\)/.test(normalized)) return "m";
  return null;
}

/** 找到某一契约字段对应的原始表头。 */
function sourceHeader(record: FlatRecord, field: string): string | null {
  for (const header of Object.keys(record)) {
    if (matchSampleHeader(header) === field) return header;
  }
  return null;
}

/**
 * 单元格 → 克重。
 *
 * 带单位的原文直接解析；纯数字必须有表头单位，否则留空 —— 不猜。
 */
function weightCell(
  value: string | undefined,
  headerUnit: WeightUnit | null,
): WeightMeasurement | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (text === "") return null;
  const parsed = parseWeightMeasurement(text);
  if (parsed) return parsed;
  if (headerUnit && /^\d+(?:\.\d+)?$/.test(text)) return { value: Number(text), unit: headerUnit };
  return null;
}

/** 单元格 → 门幅。规则与克重一致。 */
function widthCell(
  value: string | undefined,
  headerUnit: WidthUnit | null,
): WidthMeasurement | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (text === "") return null;
  const parsed = parseWidthMeasurement(text);
  if (parsed) return parsed;
  if (headerUnit && /^\d+(?:\.\d+)?$/.test(text)) return { value: Number(text), unit: headerUnit };
  return null;
}

/** 把一行原始表头记录折成契约字段；未识别的列原样保留，交给下游忽略或报错。 */
function canonicalSampleRecord(record: FlatRecord): FlatRecord {
  const canonical: FlatRecord = {};
  for (const [header, value] of Object.entries(record)) {
    const key = matchSampleHeader(header);
    if (!key) {
      canonical[header] = value;
      continue;
    }
    canonical[key] = value;
  }
  return canonical;
}

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
  const canonical = canonicalSampleRecord(record);
  const row: Record<string, unknown> = {};
  for (const column of SAMPLE_TEXT_COLUMNS) {
    const value = canonical[column];
    if (value !== undefined && value !== "") row[column] = value;
  }
  // 克重 / 门幅：表头带单位时纯数字也算数；表头没写单位就留空，不猜。
  const weightHeader = sourceHeader(record, "weight");
  const weight = weightCell(
    weightHeader === null ? undefined : record[weightHeader],
    weightHeader === null ? null : weightUnitFromHeader(weightHeader),
  );
  if (weight) row["weight"] = weight;
  const widthHeader = sourceHeader(record, "width");
  const width = widthCell(
    widthHeader === null ? undefined : record[widthHeader],
    widthHeader === null ? null : widthUnitFromHeader(widthHeader),
  );
  if (width) row["width"] = width;
  const amount = canonical["costFloorAmount"];
  if (amount !== undefined && amount !== "") {
    row["costFloor"] = {
      amount: Number(amount),
      currency: canonical["costFloorCurrency"] ?? undefined,
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
