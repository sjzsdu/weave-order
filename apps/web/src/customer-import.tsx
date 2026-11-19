"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FieldOptionWithUsage, ImportBatchResult, ImportRowError } from "@weave-order/schema";
import { MAX_IMPORT_ROWS, resolveFieldValue } from "@weave-order/schema";
import { Button, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { TIER_LABEL } from "@/format";
import { CsvImportResultPanel } from "@/csv-import-result";
import { decodeCsvBytes, downloadCsv, parseCsvRecords } from "@/csv";

// 解析原语由 csv.ts 提供；这里继续导出，旧调用方与测试不用改。
export { decodeCsvBytes, parseCsvRecords };

/** 模板与表头共用一份定义，避免模板和解析器漂移。 */
export const CUSTOMER_CSV_COLUMNS = [
  "code",
  "name",
  "tier",
  "contactName",
  "contactPhone",
  "contactEmail",
] as const;

/** 用户用中文表头也认；输出键一律用契约里的英文名。 */
const COLUMN_ALIASES: Record<string, (typeof CUSTOMER_CSV_COLUMNS)[number]> = {
  code: "code",
  客户编号: "code",
  编号: "code",
  name: "name",
  客户名称: "name",
  名称: "name",
  tier: "tier",
  等级: "tier",
  contactname: "contactName",
  联系人: "contactName",
  contactphone: "contactPhone",
  手机: "contactPhone",
  电话: "contactPhone",
  contactemail: "contactEmail",
  邮箱: "contactEmail",
};

const TIER_VALUES: Record<string, string> = {
  新客: "NEW",
  常规: "REGULAR",
  VIP: "VIP",
  沉睡: "COLD",
};

export const CUSTOMER_CSV_TEMPLATE = [
  CUSTOMER_CSV_COLUMNS.join(","),
  "C0001,杭州青禾（示例）,新客,周敏,13800000000,",
  "",
].join("\n");

export interface ParsedCustomerRow {
  /** CSV 里的真实行号（表头是第 1 行）；回执的 0-based 下标加 2 得到同一行号。 */
  line: number;
  values: Record<string, unknown>;
}

export interface ParsedCustomerCsv {
  rows: ParsedCustomerRow[];
  /** 结构性错误：表头不对、超过行数上限等。有值时不允许提交。 */
  error: string | null;
  /** 被忽略的空行数，给用户一个交代。 */
  skippedBlankRows: number;
}

/** 解析表格文本并按契约字段组装行；空单元格一律省略，交给服务端判「必填」。 */
export function parseCustomerCsv(text: string): ParsedCustomerCsv {
  const records = parseCsvRecords(text);
  if (records.length === 0) {
    return { rows: [], error: "这个文件是空的，先下载模板照着填。", skippedBlankRows: 0 };
  }

  const headerRecord = records[0];
  if (!headerRecord) {
    return { rows: [], error: "这个文件是空的，先下载模板照着填。", skippedBlankRows: 0 };
  }
  const header = headerRecord.map((cell) => cell.trim());
  const keys: Array<(typeof CUSTOMER_CSV_COLUMNS)[number] | null> = header.map((cell) => {
    const alias = COLUMN_ALIASES[cell.toLowerCase()] ?? COLUMN_ALIASES[cell];
    return alias ?? null;
  });
  const unknown = header.filter((cell, index) => cell !== "" && keys[index] === null);
  if (unknown.length > 0) {
    return {
      rows: [],
      error: `不认识的列：${unknown.join("、")}。模板列是 ${CUSTOMER_CSV_COLUMNS.join(",")}。`,
      skippedBlankRows: 0,
    };
  }
  const requiredColumns: Array<(typeof CUSTOMER_CSV_COLUMNS)[number]> = ["code", "name"];
  const missing = requiredColumns.filter((column) => !keys.includes(column));
  if (missing.length > 0) {
    return {
      rows: [],
      error: `表头缺少必填列：${missing.join("、")}。先下载模板，把客户填在模板里。`,
      skippedBlankRows: 0,
    };
  }

  const rows: ParsedCustomerRow[] = [];
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
      // 自定义等级可能是任意大小写；不能 toUpperCase 后再去匹配，原样交给解析器。
      values[key] = key === "tier" ? (TIER_VALUES[value] ?? value) : value;
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
  code: "客户编号",
  name: "客户名称",
  tier: "等级",
  contactName: "联系人",
  contactPhone: "手机",
  contactEmail: "邮箱",
};

/** Zod 的英文默认文案翻成用户看得懂的说明，其余原样带上。 */
function issueText(path: string, message: string): string {
  const field = FIELD_LABEL[path] ?? (path || "这一行");
  if (/required|at least 1 character/i.test(message)) return `${field}必填`;
  if (/at most|too_big/i.test(message)) return `${field}太长了`;
  if (/email/i.test(message)) return `${field}格式不对`;
  if (/enum|invalid/i.test(message)) {
    return field === "等级" ? "等级只能是 新客 / 常规 / VIP / 沉睡" : `${field}取值不对`;
  }
  return `${field}：${message}`;
}

/** 单行失败的可判别原因（code → 人话），不把原始枚举丢给用户。 */
export function importRowErrorText(error: ImportRowError): string {
  switch (error.code) {
    case "INVALID_INPUT":
      return error.issues.length > 0
        ? `格式不对：${error.issues
            .map((issue) => issueText(issue.path.join("."), issue.message))
            .join("；")}`
        : `格式不对：${error.message}`;
    case "DUPLICATE_IN_BATCH":
      return `客户编号和本文件第 ${error.conflictsWithRow + 2} 行重复`;
    case "DUPLICATE_IN_DB":
      return "这个客户编号已经存在，换一个编号，或先在客户列表里查一下";
    case "WRITE_FAILED":
      return `写入失败：${error.message}`;
  }
}

/** 预览单元格只展示字符串/数字；其余（理论上不会出现）显示占位符。 */
function cellText(value: unknown, fallback = "—"): string {
  if (typeof value === "string") return value === "" ? fallback : value;
  if (typeof value === "number") return String(value);
  return fallback;
}

/**
 * CSV 导入抽屉：选文件 → 本地解析 → 预览 → 确认导入 → 逐行回执。
 *
 * 只支持 CSV（不承诺 Excel）；整批原子由服务端保证，失败时一行都不落库。
 */
export function CustomerImport({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const api = useApi();
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedCustomerCsv | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportBatchResult | null>(null);
  const [tierOptions, setTierOptions] = useState<FieldOptionWithUsage[]>([]);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<
    Record<string, { mode: "create" | "map"; target?: string }>
  >({});

  // 等级列不能塞自由文本：导入前必须把不认识的值落成选项或映射到已有等级。
  useEffect(() => {
    let cancelled = false;
    api
      .listFieldOptions("customer.tier", { usage: false })
      .then((options) => {
        if (!cancelled) {
          setTierOptions(options);
          setOptionsError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setOptionsError(caught instanceof Error ? caught.message : "等级选项加载失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const unknownTiers = useMemo(() => {
    if (!parsed || parsed.error) return [];
    const counts = new Map<string, number>();
    for (const row of parsed.rows) {
      const value = row.values.tier;
      if (typeof value !== "string" || value.trim() === "") continue;
      if (resolveFieldValue("customer.tier", value, tierOptions).matched) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()].map(([value, count]) => ({ value, count }));
  }, [parsed, tierOptions]);

  const undecided = unknownTiers.filter((item) => {
    const decision = decisions[item.value];
    if (!decision) return true;
    return decision.mode === "map" && !decision.target;
  });

  async function readFile(file: File) {
    setResult(null);
    setSubmitError(null);
    setParsed(null);
    setDecisions({});
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
      setParsed(parseCustomerCsv(decodeCsvBytes(bytes)));
    } catch {
      setParsed({ rows: [], error: "文件读不出来，换一个 CSV 再试。", skippedBlankRows: 0 });
    }
  }

  async function submit() {
    if (busy || !parsed || parsed.error || parsed.rows.length === 0) return;
    if (unknownTiers.length > 0 && undecided.length > 0) {
      setSubmitError("还有新等级没有处理：创建等级或映射到已有等级后再导入。");
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      // 先把未知等级落成 code，再提交整批；任一步失败整批不导入。
      const tierMap = new Map<string, string>();
      for (const item of unknownTiers) {
        const decision = decisions[item.value];
        if (!decision) continue;
        if (decision.mode === "create") {
          const option = await api.createFieldOption("customer.tier", item.value);
          tierMap.set(item.value, option.code);
        } else if (decision.target) {
          tierMap.set(item.value, decision.target);
        }
      }
      const batch = await api.importBatch({
        customers: parsed.rows.map((row) => {
          const value = row.values.tier;
          if (typeof value !== "string") return row.values;
          const code = tierMap.get(value);
          return code ? { ...row.values, tier: code } : row.values;
        }),
      });
      setResult(batch);
      if (batch.committed) onImported();
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : "导入请求失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    downloadCsv("客户导入模板.csv", CUSTOMER_CSV_TEMPLATE);
  }

  const preview = parsed?.rows.slice(0, 20) ?? [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="导入客户"
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/30 p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-y-auto rounded-lg bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink-900">导入客户（CSV）</h2>
            <p className="mt-0.5 text-xs text-ink-400">
              选文件 → 看预览 → 确认导入。整批要么全成，要么一行都不落。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" className="min-h-9 px-3 text-xs" onClick={downloadTemplate}>
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
              successText={`已导入 ${result.importedCustomers} 位客户，全部落库。`}
              rowErrorText={importRowErrorText}
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
                <p className="mt-2 text-xs text-ink-400">
                  模板列：{CUSTOMER_CSV_COLUMNS.join(",")}；只支持 CSV，最多 {MAX_IMPORT_ROWS} 行。
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
                  {optionsError && (
                    <p
                      role="alert"
                      className="rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600"
                    >
                      等级选项没加载出来（{optionsError}），为避免导入悬挂等级，请稍后重试。
                    </p>
                  )}
                  {unknownTiers.length > 0 && (
                    <div className="rounded-lg border border-amber-600/40 bg-amber-100/30 p-3">
                      <p className="text-sm font-medium text-ink-900">
                        发现 {unknownTiers.length} 个新等级，导入前必须二选一
                      </p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        等级是引用值，不能像品类那样只留原文。创建后会成为公司共享选项。
                      </p>
                      <ul className="mt-2 grid gap-2">
                        {unknownTiers.map((item) => (
                          <li
                            key={item.value}
                            className="flex flex-wrap items-center gap-2 rounded border border-line bg-surface px-3 py-2"
                          >
                            <span className="text-sm text-ink-900">
                              {item.value}
                              <span className="ml-1 text-xs text-ink-400">（{item.count} 行）</span>
                            </span>
                            <select
                              className="input min-h-8 min-w-36 flex-1 text-xs"
                              value={
                                decisions[item.value]
                                  ? decisions[item.value]!.mode === "create"
                                    ? "__create__"
                                    : (decisions[item.value]!.target ?? "")
                                  : ""
                              }
                              onChange={(event) => {
                                const value = event.target.value;
                                setDecisions((current) => ({
                                  ...current,
                                  [item.value]:
                                    value === "__create__"
                                      ? { mode: "create" }
                                      : { mode: "map", target: value },
                                }));
                              }}
                            >
                              <option value="">选择处理方式…</option>
                              <option value="__create__">创建等级「{item.value}」并导入</option>
                              {tierOptions
                                .filter((option) => option.active)
                                .map((option) => (
                                  <option key={option.id} value={option.code}>
                                    映射到：{option.label}
                                  </option>
                                ))}
                            </select>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="overflow-x-auto rounded-lg border border-line">
                    <table className="w-full min-w-[640px] text-sm">
                      <thead className="bg-paper text-xs text-ink-400">
                        <tr>
                          <th className="px-3 py-2 text-left font-normal">行</th>
                          <th className="px-3 py-2 text-left font-normal">编号</th>
                          <th className="px-3 py-2 text-left font-normal">客户名称</th>
                          <th className="px-3 py-2 text-left font-normal">等级</th>
                          <th className="px-3 py-2 text-left font-normal">联系人</th>
                          <th className="px-3 py-2 text-left font-normal">手机</th>
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
                              {row.values.tier
                                ? (() => {
                                    const raw = cellText(row.values.tier);
                                    const resolved = resolveFieldValue(
                                      "customer.tier",
                                      raw,
                                      tierOptions,
                                    );
                                    if (resolved.matched) {
                                      return resolved.label ?? TIER_LABEL[raw] ?? raw;
                                    }
                                    return <span className="text-amber-700">新等级：{raw}</span>;
                                  })()
                                : "—"}
                            </td>
                            <td className="px-3 py-2 text-xs">
                              {cellText(row.values.contactName)}
                            </td>
                            <td className="px-3 py-2 text-xs">
                              {cellText(row.values.contactPhone)}
                            </td>
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
                disabled={
                  busy ||
                  !parsed ||
                  parsed.error !== null ||
                  parsed.rows.length === 0 ||
                  Boolean(optionsError) ||
                  undecided.length > 0
                }
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
