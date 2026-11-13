"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApprovalDetail, useApprovals, useDecideApproval } from "@weave-order/core";
import type { ApprovalItem, ApprovalKind, CreatedQuoteShare } from "@weave-order/schema";
import { ApprovalSheet, Badge, EmptyState, MoneyText, Spinner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { SharePanel } from "@/share-panel";
import { useMounted } from "@/use-mounted";
import { KIND_LABEL, relativeTime, STATUS_LABEL } from "@/format";

interface Selection {
  id: string;
  kind: ApprovalKind;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

export default function ApprovalsPage() {
  const mounted = useMounted();
  if (!mounted) {
    return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  }
  return <ApprovalsPageContent />;
}

function ApprovalsPageContent() {
  const api = useApi();
  const approvals = useApprovals(api);
  const decide = useDecideApproval(api);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<{
    id: string;
    title: string;
    created?: CreatedQuoteShare;
  } | null>(null);
  const urlSelectionRef = useRef(false);

  const items = approvals.data?.items ?? [];
  const detail = useApprovalDetail(api, selection?.id ?? null, selection?.kind ?? "quote");

  // 从工作台「看详情」带着 ?id=&kind= 进来，直接定位。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    const kind = params.get("kind");
    if (id && (kind === "quote" || kind === "sample_shipment")) {
      urlSelectionRef.current = true;
      setSelection({ id, kind });
    }
  }, []);

  useEffect(() => {
    if (!selection && !urlSelectionRef.current && items[0]) {
      setSelection({ id: items[0].id, kind: items[0].kind });
    }
  }, [items, selection]);

  const submit = useCallback(
    async (decision: "APPROVE" | "REJECT") => {
      if (!selection) return;
      setDecisionError(null);
      setNotice(null);
      try {
        const result = await decide.mutateAsync({ ...selection, decision });
        if (result.ok) {
          setNotice(
            decision === "APPROVE" ? "已批准，内核已 confirm 生效。" : "已驳回并写入审计。",
          );
          const approved = selection;
          const title =
            items.find((item) => item.id === approved.id)?.title ?? approved.id.slice(0, 8);
          setSelection(null);
          // 批准后立即生成客户链接并展示：明文 token 只返回一次，不能等下次再取。
          if (decision === "APPROVE" && approved.kind === "quote") {
            try {
              const created = await api.createQuoteShare({
                quoteId: approved.id,
                requirePhoneTail: true,
                allowPdf: true,
              });
              setShareTarget({ id: approved.id, title, created });
            } catch {
              // 生成失败不否定批准结果；业务员可在全景窗口重试。
            }
          }
        } else {
          setDecisionError(result.error.message);
        }
      } catch (cause) {
        setDecisionError(cause instanceof Error ? cause.message : "决策失败，请稍后重试");
      }
    },
    [api, decide, items, selection],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const index = items.findIndex((item) => item.id === selection?.id);
      if (event.key === "j" || event.key === "J") {
        const next = items[Math.min(index + 1, items.length - 1)];
        if (next) setSelection({ id: next.id, kind: next.kind });
        event.preventDefault();
      } else if (event.key === "k" || event.key === "K") {
        const next = items[Math.max(index - 1, 0)];
        if (next) setSelection({ id: next.id, kind: next.kind });
        event.preventDefault();
      } else if (event.key === "a" || event.key === "A") {
        void submit("APPROVE");
      } else if (event.key === "r" || event.key === "R") {
        void submit("REJECT");
      } else if (event.key === "Escape") {
        setSelection(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, selection, submit]);

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">审批</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">你只做决定，草稿由智能体准备</h1>
          <p className="mt-1 text-sm text-ink-400">
            快捷键：J/K 切换 · A 批准 · R 驳回 · Esc 关闭详情
          </p>
        </div>
        <Badge tone={items.length > 0 ? "danger" : "success"}>{items.length} 件待批</Badge>
      </header>

      {notice && (
        <p className="rounded-md border border-moss-600/30 bg-moss-600/10 px-3 py-2 text-sm text-moss-600">
          {notice}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <aside className="grid content-start gap-2" aria-label="待审批队列">
          {approvals.isLoading && <Spinner label="读取审批队列…" />}
          {approvals.isError && (
            <p className="rounded-md border border-vermilion-600/30 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600">
              审批队列读取失败：
              {approvals.error instanceof Error ? approvals.error.message : "未知错误"}
            </p>
          )}
          {!approvals.isLoading && items.length === 0 && (
            <EmptyState title="队列空了" description="批准或驳回后，这里会自动消失。" />
          )}
          {items.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              active={selection?.id === item.id}
              onClick={() => {
                setSelection({ id: item.id, kind: item.kind });
                setDecisionError(null);
              }}
            />
          ))}
        </aside>

        <section aria-live="polite">
          {!selection ? (
            <EmptyState
              title={items.length > 0 ? "选一条待批单据" : "当前没有待批单据"}
              description={
                items.length > 0
                  ? "左侧点一条，或用 J/K 切换；批准后走后端 confirm，前端不落账。"
                  : "新的智能体草稿会出现在队列里。"
              }
            />
          ) : (
            <ApprovalSheet
              detail={detail.data ?? null}
              loading={detail.isLoading}
              error={
                detail.isError
                  ? detail.error instanceof Error
                    ? detail.error.message
                    : "读取失败"
                  : null
              }
              busy={decide.isPending}
              decisionError={decisionError}
              onApprove={() => void submit("APPROVE")}
              onReject={() => void submit("REJECT")}
              onRevise={() => setNotice("改价由 Track A 的 reviseDraft 提供；当前先走 Chat 改稿。")}
              onAskAgent={() => setNotice("已请小织解释（Agent 接入后回填）。")}
            />
          )}
        </section>
      </div>

      {shareTarget && (
        <SharePanel
          quoteId={shareTarget.id}
          title={shareTarget.title}
          initialCreated={shareTarget.created}
          onClose={() => setShareTarget(null)}
        />
      )}
    </div>
  );
}

function QueueRow({
  item,
  active,
  onClick,
}: {
  item: ApprovalItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "rounded-lg border px-3 py-3 text-left transition-colors",
        active
          ? "border-indigo-600 bg-indigo-100/60 ring-1 ring-indigo-600/20"
          : "border-line bg-surface hover:border-ink-400",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Badge tone="info">{KIND_LABEL[item.kind] ?? item.kind}</Badge>
          <span className="truncate text-sm font-medium text-ink-900">{item.title}</span>
        </span>
        <MoneyText
          money={
            item.amountCents !== null && item.currency
              ? { amount: item.amountCents, currency: item.currency }
              : null
          }
          size="sm"
        />
      </div>
      <p className="mt-1 truncate text-xs text-ink-400">{item.summary}</p>
      <div className="mt-2 flex items-center justify-between text-xs text-ink-400">
        <span>{STATUS_LABEL[item.status] ?? item.status}</span>
        <span>{relativeTime(item.createdAt)}</span>
      </div>
    </button>
  );
}
