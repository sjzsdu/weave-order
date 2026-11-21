"use client";

import { useState } from "react";
import type { IntentView } from "@weave-order/schema";
import { Badge, Button, cn } from "./primitives";

/**
 * 可追踪的运行卡：一句话的完整去向都在这张卡上。
 *
 * 三种结局都必须可见，且不允许「绿色成功条 + 无后续」：
 * - 成功：草稿已生成 → 去审批（真实链接）
 * - 失败：人话原因 + 重试 + 转人工
 * - 超时：明确说超过 60 秒，原话保留可重试
 * - 执行器未接入：琥珀色「待受理」，写明不会被自动处理
 */
export function IntentRunCard({
  intent,
  onCancel,
  onRetry,
  busy,
  className,
}: {
  intent: IntentView;
  onCancel?: (id: string) => void;
  onRetry?: (intent: IntentView) => void;
  busy?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const waiting = intent.status === "QUEUED" || intent.status === "RUNNING";
  const failed = intent.status === "FAILED" || intent.status === "TIMEOUT";
  // 缺信息不是失败：草稿还差几个阻断项，补齐后重试即可。
  const needsInput = intent.status === "NEEDS_INPUT";
  const needsAttention = failed || needsInput;
  const notConnected = intent.executorState === "NOT_CONNECTED";
  const awaitingConfirm =
    intent.status === "SUCCEEDED" && intent.understanding !== null && !intent.draft;

  const tone =
    intent.status === "SUCCEEDED"
      ? "success"
      : failed
        ? "danger"
        : needsInput
          ? "warning"
          : waiting && notConnected
            ? "warning"
            : waiting
              ? "info"
              : "neutral";

  // 失败后的人才兜底：不额外造一条「转人工」单据，先把原话送到用户手上。
  const escalate = async () => {
    try {
      await navigator.clipboard.writeText(intent.text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article
      className={cn(
        "rounded-lg border bg-surface px-4 py-3",
        intent.status === "SUCCEEDED" && "border-moss-600/40",
        failed && "border-vermilion-600/40",
        needsInput && "border-amber-600/40",
        waiting && notConnected && "border-amber-600/40",
        waiting && !notConnected && "border-indigo-600/30",
        (intent.status === "CANCELLED" || needsAttention) && "bg-paper/60",
        className,
      )}
      data-intent-id={intent.id}
      data-intent-status={intent.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{intent.statusLabel}</Badge>
        <span className="text-xs text-ink-400">小织 · 意图 #{intent.id.slice(0, 8)}</span>
      </div>

      <p
        className={cn(
          "mt-2 whitespace-pre-wrap text-sm text-ink-900",
          intent.status === "CANCELLED" && "text-ink-400 line-through",
        )}
      >
        「{intent.text}」
      </p>

      {intent.notice && (
        <p
          className={cn(
            "mt-2 text-sm",
            failed
              ? "text-vermilion-600"
              : needsInput
                ? "text-amber-700"
                : waiting && notConnected
                  ? "text-amber-700"
                  : "text-ink-700",
          )}
        >
          {intent.notice}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {awaitingConfirm && (
          <a
            href={`/inbound?intent=${encodeURIComponent(intent.id)}`}
            className="inline-flex min-h-9 items-center rounded-md border border-indigo-600/40 bg-indigo-600/10 px-3 text-sm font-medium text-indigo-600 hover:bg-indigo-600/15"
          >
            继续确认 →
          </a>
        )}

        {intent.status === "SUCCEEDED" && intent.draft && (
          <a
            href={`/approvals?id=${encodeURIComponent(intent.draft.id)}&kind=${intent.draft.kind}`}
            className="inline-flex min-h-9 items-center rounded-md border border-moss-600/40 bg-moss-600/10 px-3 text-sm font-medium text-moss-600 hover:bg-moss-600/15"
          >
            去审批「{intent.draft.title}」→
          </a>
        )}

        {waiting && intent.cancellableUntil && onCancel && (
          <Button
            variant="ghost"
            className="min-h-9 px-3"
            disabled={busy}
            onClick={() => onCancel(intent.id)}
          >
            撤销
          </Button>
        )}

        {needsAttention && onRetry && (
          <Button
            variant="secondary"
            className="min-h-9 px-3"
            disabled={busy}
            onClick={() => onRetry(intent)}
          >
            {needsInput ? "补齐信息后重试" : "重试"}
          </Button>
        )}

        {needsAttention && (
          <Button variant="ghost" className="min-h-9 px-3" onClick={() => void escalate()}>
            {copied ? "已复制，发给同事" : "转人工"}
          </Button>
        )}

        {intent.status === "CANCELLED" && (
          <span className="text-xs text-ink-400">这句话不会再被处理。</span>
        )}
      </div>
    </article>
  );
}
