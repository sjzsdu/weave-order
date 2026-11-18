"use client";

import { useRef, useState } from "react";
import type { ImportBatchResult, ImportRowError } from "@weave-order/schema";
import { MAX_IMPORT_ROWS } from "@weave-order/schema";
import { Button, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { CsvImportResultPanel } from "@/csv-import-result";
import { decodeCsvBytes, downloadCsv, parseCsvRecords } from "@/csv";

/**
 * 样品 CSV 导入：选文件 → 本地解析 → 预览 → 确认导入 → 逐行回执。
 *
 * 与客户导入共用解析原语与回执面板。只支持 CSV（不承诺 Excel），
 * 整批原子由服务端保证。导入不带图，图请在图墙里补。
 */

/** 模板与解析器共用一份列定义，避免模板和代码漂移。 */
export const SAMPLE_CSV_COLUMNS = [
  "code",
  "name",
  "composition",
  "category",
  "weight",
  "unit",
  "costFloorYuan",
  "status",
] as const;

type SampleColumn = (typeof SAMPLE_CSV_COLUMNS)[number];

/** 用户用中文表头也认；输出键一律用契约里的英文名。 */
const COLUMN_ALIASES: Record<string, SampleColumn> = {
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
  weight: "weight",
  克重: "weight",
  unit: "unit",
  单位: "unit",
  costflooryuan: "costFloorYuan",
  成本底线: "costFloorYuan",
  成本价: "costFloorYuan",
  status: "status",
  状态: "status",
};

const UNIT_VALUES: Record<string, string> = {
  米: "meter",
  公斤: "kilogram",
  千克: "kilogram",
  码: "yard",
  件: "piece",
};

/** 预览里把契约枚举还原成中文，不把 `meter` 这种原始值丢给用户。 */
const UNIT_LABEL: Record<string, string> = {
  meter: "米",
  kilogram: "公斤",
  yard: "码",
  piece: "件",
};

const STATUS_VALUES: Record<string, string> = {
  在售: "ACTIVE",
  已归档: "ARCHIVED",
  归档: "ARCHIVED",
};

export const SAMPLE_CSV_TEMPLATE = [
  SAMPLE_CSV_COLUMNS.join(","),
  "SP-0001,32S 精梳棉汗布,100% 棉,针织,220g/m²,米,18.5,在售",
  "",
].join("\n");

export interface ParsedSampleRow {
  /** CSV 里的真实行号（表头是第 1 行）；回执的 0-based 下标加 2 得到同一行号。 */
  line: number;
  values: Record<string, unknown>;
}

export interface ParsedSampleCsv {
  rows: ParsedSampleRow[];
  error: string | null;
  skippedBlankRows: number;
}

/** 元 → 分（契约里金额是整数分）；非法值原样交给服务端判 INVALID_INPUT。 */
function costFloorCell(value: string): unknown {
  const yuan = Number(value);
  if (!Number.isFinite(yuan) || yuan < 0) return value;
  return { amount: Math.round(yuan * 100), currency: "CNY" };
}

/** 解析表格文本并按契约字段组装行；空单元格一律省略，交给服务端判「必填」。 */
export function parseSampleCsv(text: string): ParsedSampleCsv {
  const records = parseCsvRecords(text);
  if (records.length === 0) {
    return { rows: [], error: "这个文件是空的，先下载模板照着填。", skippedBlankRows: 0 };
  }

  const headerRecord = records[0];
  if (!headerRecord) {
    return { rows: [], error: "这个文件是空的，先下载模板照着填。", skippedBlankRows: 0 };
  }
  const header = headerRecord.map((cell) => cell.trim());
  const keys: Array<SampleColumn | null> = header.map((cell) => {
    return COLUMN_ALIASES[cell.toLowerCase()] ?? COLUMN_ALIASES[cell] ?? null;
  });
  const unknown = header.filter((cell, index) => cell !== "" && keys[index] === null);
  if (unknown.length > 0) {
    return {
      rows: [],
      error: `不认识的列：${unknown.join("、")}。模板列是 ${SAMPLE_CSV_COLUMNS.join(",")}。`,
      skippedBlankRows: 0,
    };
  }
  const requiredColumns: SampleColumn[] = ["code", "name"];
  const missing = requiredColumns.filter((column) => !keys.includes(column));
  if (missing.length > 0) {
    return {
      rows: [],
      error: `表头缺少必填列：${missing.join("、")}。先下载模板，把样品填在模板里。`,
      skippedBlankRows: 0,
    };
  }

  const rows: ParsedSampleRow[] = [];
  let skippedBlankRows = 0;
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.every((cell) => cell.trim() === "")) {
      skippedBlankRows += 1;
      continue;
    }
    const values: Record<string, unknown> = {};
    record.forEach((cell, cellIndex) => {
      const key = keys[cellIndex];
      const value = cell.trim();
      if (!key || value === "") return;
      if (key === "unit") values.unit = UNIT_VALUES[value] ?? value;
      else if (key === "status") values.status = STATUS_VALUES[value] ?? value.toUpperCase();
      else if (key === "costFloorYuan") values.costFloor = costFloorCell(value);
      else values[key] = value;
    });
    rows.push({ line: index + 1, values });
  }

  if (rows.length === 0) {
    return { rows, error: "除了表头没有数据行。", skippedBlankRows };
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return {
      rows,
      error: `一次最多导 ${MAX_IMPORT_ROWS} 行，这个文件有 ${rows.length} 行，请拆成多个文件。`,
      skippedBlankRows,
    };
  }
  return { rows, error: null, skippedBlankRows };
}

const FIELD_LABEL: Record<string, string> = {
  code: "样品编号",
  name: "品名",
  composition: "成分",
  category: "品类",
  weight: "克重",
  unit: "单位",
  status: "状态",
  costFloor: "成本底线",
};

/** Zod 的英文默认文案翻成用户看得懂的说明，其余原样带上。 */
function issueText(path: string, message: string): string {
  const field = FIELD_LABEL[path] ?? (path || "这一行");
  if (/required|at least 1 character/i.test(message)) return `${field}必填`;
  if (/at most|too_big/i.test(message)) return `${field}太长了`;
  if (/number|nan|finite/i.test(message)) return `${field}填数字，单位是元`;
  if (/integer/i.test(message)) return `${field}单位是元，最多两位小数`;
  if (/enum|invalid/i.test(message)) {
    if (field === "单位") return "单位只能是 米 / 公斤 / 码 / 件";
    if (field === "状态") return "状态只能是 在售 / 已归档";
    return `${field}取值不对`;
  }
  return `${field}：${message}`;
}

/** 单行失败的可判别原因（code → 人话），不把原始枚举丢给用户。 */
export function sampleImportRowErrorText(error: ImportRowError): string {
  switch (error.code) {
    case "INVALID_INPUT":
      return error.issues.length > 0
        ? `格式不对：${error.issues
            .map((issue) => issueText(issue.path.join("."), issue.message))
            .join("；")}`
        : `格式不对：${error.message}`;
    case "DUPLICATE_IN_BATCH":
      return `样品编号和本文件第 ${error.conflictsWithRow + 2} 行重复`;
    case "DUPLICATE_IN_DB":
      return "这个样品编号已经存在，换一个编号，或先在样品图墙里查一下";
    case "WRITE_FAILED":
      return `写入失败：${error.message}`;
  }
}

/** 预览单元格只展示字符串/数字；成本底线把分还原成元。 */
function cellText(value: unknown, fallback = "—"): string {
  if (typeof value === "string") return value === "" ? fallback : value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && value !== null && "amount" in value) {
    const amount = (value as { amount?: unknown }).amount;
    if (typeof amount === "number") return `¥${(amount / 100).toFixed(2)}`;
  }
  return fallback;
}

export function SampleImport({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (count: number) => void;
}) {
  const api = useApi();
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedSampleCsv | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportBatchResult | null>(null);

  async function readFile(file: File) {
    setResult(null);
    setSubmitError(null);
    setParsed(null);
    setFileName(file.name);
    if (!/\.csv$/i.test(file.name)) {
      setParsed({
        rows: [],
        error: "只支持 CSV 文件。Excel 请先「另存为 CSV」。",
        skippedBlankRows: 0,
      });
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setParsed(parseSampleCsv(decodeCsvBytes(bytes)));
    } catch {
      setParsed({ rows: [], error: "文件读不出来，换一个 CSV 再试。", skippedBlankRows: 0 });
    }
  }

  async function submit() {
    if (busy || !parsed || parsed.error || parsed.rows.length === 0) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const batch = await api.importBatch({
        samples: parsed.rows.map((row) => row.values),
      });
      setResult(batch);
      if (batch.committed) onImported(batch.importedSamples);
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : "导入请求失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  const preview = parsed?.rows.slice(0, 20) ?? [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="导入样品"
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/30 p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-y-auto rounded-lg bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-900">导入样品（CSV）</h2>
            <p className="mt-0.5 text-xs text-ink-400">
              选文件 → 看预览 → 确认导入。整批要么全成，要么一行都不落。图片导入后在图墙里补。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <Button
              variant="ghost"
              className="min-h-9 px-3 text-xs"
              onClick={() => downloadCsv("样品导入模板.csv", SAMPLE_CSV_TEMPLATE)}
            >
              下载模板
            </Button>
            <Button
              variant="ghost"
              className="min-h-9 px-3 text-xs"
              onClick={onClose}
              disabled={busy}
            >
              关闭
            </Button>
          </div>
        </header>

        <div className="grid gap-4 px-5 py-5">
          {submitError && (
            <p
              role="alert"
              className="rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600"
            >
              {submitError}
            </p>
          )}

          {result && (
            <CsvImportResultPanel
              result={result}
              successText={`已导入 ${result.importedSamples} 个样品，全部落库。去图墙点开卡片补图。`}
              rowErrorText={sampleImportRowErrorText}
            />
          )}

          {!result && (
            <>
              <div
                className={cn(
                  "rounded-lg border border-dashed px-4 py-8 text-center text-sm",
                  dragging ? "border-indigo-600 bg-indigo-100/30" : "border-line bg-paper/40",
                )}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  const file = event.dataTransfer.files[0];
                  if (file) void readFile(file);
                }}
              >
                <p className="text-ink-700">把 CSV 拖到这里，或</p>
                <div className="mt-2 flex items-center justify-center gap-2">
                  <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                    选择文件
                  </Button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".csv,text/csv"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void readFile(file);
                      event.target.value = "";
                    }}
                  />
                </div>
                <p className="mt-2 break-all text-xs text-ink-400">
                  模板列：{SAMPLE_CSV_COLUMNS.join(",")}；只支持 CSV，最多 {MAX_IMPORT_ROWS} 行。
                </p>
              </div>

              {parsed?.error && (
                <p
                  role="alert"
                  className="rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600"
                >
                  {parsed.error}
                </p>
              )}

              {parsed && !parsed.error && (
                <section className="grid gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-ink-900">
                      {fileName} · 共 {parsed.rows.length} 行
                    </span>
                    <span className="text-xs text-ink-400">
                      预览前 {preview.length} 行
                      {parsed.skippedBlankRows > 0
                        ? ` · 已跳过 ${parsed.skippedBlankRows} 个空行`
                        : ""}
                    </span>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-line">
                    <table className="w-full min-w-[720px] text-sm">
                      <thead className="bg-paper text-xs text-ink-400">
                        <tr>
                          <th className="px-3 py-2 text-left font-normal">行</th>
                          <th className="px-3 py-2 text-left font-normal">编号</th>
                          <th className="px-3 py-2 text-left font-normal">品名</th>
                          <th className="px-3 py-2 text-left font-normal">成分</th>
                          <th className="px-3 py-2 text-left font-normal">克重</th>
                          <th className="px-3 py-2 text-left font-normal">单位</th>
                          <th className="px-3 py-2 text-left font-normal">成本底线</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {preview.map((row) => (
                          <tr key={row.line}>
                            <td className="px-3 py-2 text-xs text-ink-400">{row.line}</td>
                            <td className="px-3 py-2 font-mono text-xs">
                              {cellText(row.values.code)}
                            </td>
                            <td className="px-3 py-2">{cellText(row.values.name, "（空）")}</td>
                            <td className="px-3 py-2 text-xs">
                              {cellText(row.values.composition)}
                            </td>
                            <td className="px-3 py-2 text-xs">{cellText(row.values.weight)}</td>
                            <td className="px-3 py-2 text-xs">
                              {UNIT_LABEL[cellText(row.values.unit, "")] ??
                                cellText(row.values.unit)}
                            </td>
                            <td className="px-3 py-2 text-xs">{cellText(row.values.costFloor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}
        </div>

        <footer className="mt-auto flex items-center justify-end gap-2 border-t border-line px-5 py-4">
          {result ? (
            <Button variant="primary" onClick={onClose}>
              完成
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose} disabled={busy}>
                取消
              </Button>
              <Button
                variant="primary"
                onClick={() => void submit()}
                disabled={busy || !parsed || parsed.error !== null || parsed.rows.length === 0}
              >
                {busy ? "正在导入…" : "确认导入"}
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
