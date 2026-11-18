"use client";

import type { ImportBatchResult, ImportRowError } from "@weave-order/schema";

/**
 * 导入回执面板：客户 / 样品共用。
 * 成功只说落库了多少；失败必须讲清「一行都没落库」并逐行给原因，
 * 不让用户以为部分成功。
 */
export function CsvImportResultPanel({
  result,
  successText,
  rowErrorText,
}: {
  result: ImportBatchResult;
  successText: string;
  rowErrorText: (error: ImportRowError) => string;
}) {
  const failures = result.rows.filter((row) => !row.ok);
  return (
    <section className="grid gap-3">
      {result.committed ? (
        <p className="rounded-md border border-moss-600/30 bg-moss-600/10 px-3 py-2 text-sm text-moss-600">
          {successText}
        </p>
      ) : (
        <div className="rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600">
          <p className="font-medium">一行都没落库，修好再导。</p>
          <p className="mt-0.5">
            共 {result.totalRows} 行，{result.rejectedRows} 行有问题
            {result.batchError ? `（${result.batchError.message}）` : ""}。
          </p>
        </div>
      )}

      {failures.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-paper text-xs text-ink-400">
              <tr>
                <th className="px-3 py-2 text-left font-normal">行</th>
                <th className="px-3 py-2 text-left font-normal">编号</th>
                <th className="px-3 py-2 text-left font-normal">失败原因</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {failures.map((row) => (
                <tr key={`${row.kind}-${row.row}`}>
                  <td className="px-3 py-2 text-xs text-ink-400">第 {row.row + 2} 行</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.key}</td>
                  <td className="px-3 py-2 text-vermilion-600">{rowErrorText(row.error)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
