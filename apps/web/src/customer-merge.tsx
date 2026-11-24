"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCustomerList } from "@weave-order/core";
import { ApiError } from "@weave-order/core";
import type {
  Customer,
  CustomerListItem,
  CustomerMergePreview,
  CustomerMergeResult,
  CustomerMergeUndoResult,
} from "@weave-order/schema";
import { Button, Spinner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";

/**
 * 客户合并对话框（WAN-214）：两步确认 + 可撤销。
 *
 * 后端强制预览票据（10 分钟有效）的设计是对的——防盲合并，这里如实呈现：
 * 必须「选目标 → 看影响 → 确认」三步走，不做一键合并。合并成功后回滚窗口内
 * 可撤销（结果里的 undoToken），撤销后数据回到合并前。
 */

const COUNT_ROWS: Array<{ key: keyof CustomerMergePreview["counts"]; label: string }> = [
  { key: "quotes", label: "报价" },
  { key: "orders", label: "订单" },
  { key: "sampleShipments", label: "寄样单" },
  { key: "receivables", label: "应收" },
  { key: "items", label: "事项" },
  { key: "contacts", label: "联系人" },
  { key: "decisionDeltas", label: "决策变更" },
];

const CONFLICT_REASON_LABEL: Record<string, string> = {
  PHONE: "手机号相同",
  EMAIL: "邮箱相同",
  PRIMARY: "与目标客户主要联系人冲突",
};

const FIELD_CLASS =
  "min-h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink-900 outline-none focus:border-indigo-600";

/** 后端按 reason 拒掉的场景映射成人话；其余直接用后端给的中文 message。 */
export function mergeErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    const reason = (cause.details as { reason?: string } | undefined)?.reason;
    if (reason === "MERGE_SELF") return "不能把客户合并到自己。";
    if (reason === "MERGE_SOURCE_ARCHIVED") return "已归档客户不能再合并。";
    if (reason === "MERGE_TARGET_NOT_AVAILABLE") return "只能合并到可用客户。";
    if (reason === "MERGE_PREVIEW_MISMATCH" || reason === "MERGE_TOKEN_INVALID") {
      return "预览已过期，请重新预览后再合并。";
    }
    if (reason === "MERGE_UNDO_MISMATCH") return "撤销票据与合并记录不一致。";
    if (reason === "MERGE_UNDO_NOT_AVAILABLE") return "没有可撤销的合并，或已经撤销过了。";
    if (cause.status === 403) return "当前角色没有合并客户的权限。";
    if (cause.message) return cause.message;
    return "操作失败，请稍后重试。";
  }
  if (cause instanceof Error && cause.message) return cause.message;
  return "操作失败，请稍后重试。";
}

/** 预览票据是否已过期：过期后确认会失败，需要重新预览。 */
export function isPreviewExpired(expiresAt: string): boolean {
  const time = new Date(expiresAt).getTime();
  if (Number.isNaN(time)) return true;
  return Date.now() >= time;
}

function formatExpiry(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function CustomerMergeDialog({
  sourceCustomer,
  onClose,
}: {
  sourceCustomer: Customer;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<CustomerListItem | null>(null);
  const [preview, setPreview] = useState<CustomerMergePreview | null>(null);
  const [result, setResult] = useState<CustomerMergeResult | null>(null);
  const [undo, setUndo] = useState<CustomerMergeUndoResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 搜索走防抖，避免每敲一个字打一次后端（与客户列表页同一做法）。
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const candidatesQuery = useCustomerList(api, {
    query: debouncedQuery || undefined,
    limit: 50,
    owner: "all",
    sort: "recent",
  });

  // 结果列表排除源客户自己：合并到自己由前端直接拦住，不发请求。
  const candidates = useMemo(
    () => (candidatesQuery.data ?? []).filter((entry) => entry.id !== sourceCustomer.id),
    [candidatesQuery.data, sourceCustomer.id],
  );

  async function refreshLinkedQueries() {
    // 合并动了报价/订单/应收/联系人的归属，列表、360、审批与全景都要刷新。
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["customers"] }),
      queryClient.invalidateQueries({ queryKey: ["panorama"] }),
      queryClient.invalidateQueries({ queryKey: ["quotes"] }),
      queryClient.invalidateQueries({ queryKey: ["orders"] }),
      queryClient.invalidateQueries({ queryKey: ["receivables"] }),
      queryClient.invalidateQueries({ queryKey: ["approvals"] }),
    ]);
  }

  async function runPreview(targetId: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.previewCustomerMerge(sourceCustomer.id, targetId);
      setPreview(next);
    } catch (cause) {
      setError(mergeErrorMessage(cause));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  function chooseTarget(entry: CustomerListItem) {
    setTarget(entry);
    setPreview(null);
    setResult(null);
    void runPreview(entry.id);
  }

  /** 目标还是同一个；预览过期后重新生成票据，不让用户退出重进。 */
  async function confirmMerge() {
    if (!target || !preview) return;
    if (isPreviewExpired(preview.expiresAt)) {
      setError("预览已过期，正在重新生成预览，请再次确认。");
      setPreview(null);
      await runPreview(target.id);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api.mergeCustomer(sourceCustomer.id, {
        targetCustomerId: target.id,
        previewToken: preview.previewToken,
      });
      setResult(next);
      setPreview(null);
      await refreshLinkedQueries();
    } catch (cause) {
      // 预览票据过期（后端 MERGE_TOKEN_INVALID）或目标不一致：重新预览即可继续。
      setError(mergeErrorMessage(cause));
      if (
        cause instanceof ApiError &&
        (cause.details as { reason?: string } | undefined)?.reason === "MERGE_TOKEN_INVALID"
      ) {
        await runPreview(target.id);
      }
    } finally {
      setBusy(false);
    }
  }

  async function undoMerge() {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const reverted = await api.undoCustomerMerge(sourceCustomer.id, {
        undoToken: result.undoToken,
      });
      setUndo(reverted);
      await refreshLinkedQueries();
    } catch (cause) {
      setError(mergeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const expired = preview ? isPreviewExpired(preview.expiresAt) : false;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="合并到其他客户"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 px-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex max-h-[min(92vh,720px)] w-full max-w-[600px] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink-900">合并到其他客户</h2>
            <p className="mt-0.5 text-xs text-ink-400">
              把「{sourceCustomer.name}」（{sourceCustomer.code}）的单据与联系人并入目标客户，
              合并后当前客户归档，10 分钟内可撤销。
            </p>
          </div>
          <Button
            variant="ghost"
            className="min-h-9 px-3 text-xs"
            onClick={onClose}
            disabled={busy}
          >
            关闭
          </Button>
        </header>

        <div className="grid gap-4 overflow-y-auto px-5 py-5">
          {error && (
            <p
              role="alert"
              className="rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600"
            >
              {error}
            </p>
          )}

          {/* 第一步：选目标客户 */}
          {!preview && !result && (
            <div className="grid gap-3">
              <label className="grid gap-1 text-xs text-ink-400">
                目标客户
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className={FIELD_CLASS}
                  placeholder="按客户名 / 编号搜索"
                />
              </label>

              {candidatesQuery.isLoading ? (
                <div className="px-2 py-6">
                  <Spinner label="正在搜索客户…" />
                </div>
              ) : candidatesQuery.isError ? (
                <p className="px-2 py-4 text-sm text-vermilion-600">
                  客户列表读取失败，请稍后重试。
                </p>
              ) : candidates.length === 0 ? (
                <p className="px-2 py-4 text-sm text-ink-400">
                  {debouncedQuery ? "没有匹配的客户，换个关键词。" : "没有可合并的客户。"}
                </p>
              ) : (
                <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line">
                  {candidates.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-paper disabled:opacity-50"
                        onClick={() => chooseTarget(entry)}
                        disabled={busy}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-ink-900">
                            {entry.name}
                          </span>
                          <span className="block truncate text-xs text-ink-400">
                            {entry.code}
                            {entry.contactName ? ` · ${entry.contactName}` : ""}
                          </span>
                        </span>
                        <span aria-hidden className="text-xs text-ink-400">
                          ›
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 第二步：影响预览 */}
          {preview && !result && (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-paper/50 px-3 py-2.5 text-sm">
                <span className="font-medium text-ink-900">{sourceCustomer.name}</span>
                <span aria-hidden className="text-ink-400">
                  →
                </span>
                <span className="font-medium text-indigo-600">
                  {target?.name ?? "目标客户"}
                </span>
                <span className="text-xs text-ink-400">
                  {target?.code ?? ""}
                </span>
              </div>

              <section aria-label="将转移的数据" className="grid gap-1.5">
                <h3 className="text-xs font-medium text-ink-700">会转移的数据</h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {COUNT_ROWS.map(({ key, label }) => (
                    <div key={key} className="rounded-md border border-line px-3 py-2">
                      <div className="text-xs text-ink-400">{label}</div>
                      <div className="mt-0.5 font-mono text-xl font-bold tabular-nums text-ink-900">
                        {preview.counts[key]}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {preview.contactConflicts.length > 0 && (
                <section
                  aria-label="联系人冲突"
                  className="rounded-md border border-amber-500/40 bg-amber-100/40 px-3 py-2.5"
                >
                  <h3 className="text-xs font-medium text-ink-700">
                    有 {preview.contactConflicts.length} 个联系人不会迁移
                  </h3>
                  <p className="mt-1 text-sm text-ink-700">
                    目标客户已有同手机号 / 邮箱的联系人，这些联系人会留在「
                    {sourceCustomer.name}」下：
                  </p>
                  <ul className="mt-1 grid gap-0.5 text-xs text-ink-700">
                    {preview.contactConflicts.map((conflict) => (
                      <li key={conflict.contactId}>
                        · {CONFLICT_REASON_LABEL[conflict.reason] ?? conflict.reason}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <p
                className={cn(
                  "text-xs",
                  expired ? "text-vermilion-600" : "text-ink-400",
                )}
              >
                预览有效期至 {formatExpiry(preview.expiresAt)}
                {expired ? "，已过期，请点「确认合并」重新预览。" : "，过期需重新预览。"}
              </p>
            </div>
          )}

          {/* 第三步：结果（含撤销入口） */}
          {result && (
            <div className="grid gap-4">
              {undo ? (
                <div className="grid gap-1 py-1">
                  <h3 className="text-base font-semibold text-ink-900">已撤销合并</h3>
                  <p className="text-sm text-ink-700">
                    「{sourceCustomer.name}」恢复为合并前的状态，
                    {COUNT_ROWS.filter(({ key }) => undo.reverted[key] > 0).length > 0
                      ? "已转移的数据全部回到原客户"
                      : "没有转移过数据"}
                    。
                  </p>
                </div>
              ) : (
                <div className="grid gap-4">
                  <div className="grid gap-1 py-1">
                    <h3 className="text-base font-semibold text-ink-900">合并完成</h3>
                    <p className="text-sm text-ink-700">
                      「{sourceCustomer.name}」已并入「{target?.name ?? "目标客户"}」，
                      {result.moved.contacts > 0
                        ? `转移了 ${result.moved.contacts} 个联系人`
                        : "没有可转移的联系人"}
                      {result.skippedContactCount > 0
                        ? `，跳过了 ${result.skippedContactCount} 个冲突联系人`
                        : ""}
                      。源客户已归档。
                    </p>
                  </div>
                  <div className="rounded-md border border-moss-600/30 bg-moss-600/5 px-3 py-2.5 text-xs text-ink-700">
                    撤销窗口截止至 {formatExpiry(result.undoUntil)}：窗口内可完整回滚，
                    把单据与联系人退回「{sourceCustomer.name}」。
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-4">
          {!preview && !result && (
            <Button className="min-h-9 px-3 text-xs" onClick={onClose} disabled={busy}>
              取消
            </Button>
          )}

          {preview && !result && (
            <>
              <Button
                className="min-h-9 px-3 text-xs"
                onClick={() => {
                  setTarget(null);
                  setPreview(null);
                }}
                disabled={busy}
              >
                返回重选
              </Button>
              <Button
                variant="primary"
                className="min-h-9 px-3 text-xs"
                disabled={busy}
                onClick={() => {
                  // 过期时只重新生成预览并回到确认态；未过期才真正合并。
                  if (expired && target) void runPreview(target.id);
                  else void confirmMerge();
                }}
              >
                {busy
                  ? expired
                    ? "正在重新预览…"
                    : "正在合并…"
                  : expired
                    ? "重新预览"
                    : "确认合并"}
              </Button>
            </>
          )}

          {result && !undo && (
            <>
              <a
                href={`/panorama/customers/${encodeURIComponent(target?.id ?? "")}`}
                className="text-xs text-indigo-600 underline underline-offset-2"
              >
                查看目标客户 360
              </a>
              <Button
                variant="danger"
                className="min-h-9 px-3 text-xs"
                disabled={busy}
                onClick={() => void undoMerge()}
              >
                {busy ? "正在撤销…" : "撤销合并"}
              </Button>
            </>
          )}

          {result && undo && (
            <Button
              variant="primary"
              className="min-h-9 px-3 text-xs"
              onClick={onClose}
              disabled={busy}
            >
              完成
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
