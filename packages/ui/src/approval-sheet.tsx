"use client";

import type { ApprovalDetail } from "@weave-order/schema";
import { Badge, Button, EmptyState, Spinner, cn } from "./primitives";
import { DraftCard } from "./draft-card";
import { DiffRow } from "./diff-row";
import { MoneyText } from "./money-text";
import { MissingFieldBadge } from "./missing-field-badge";
import { ProvenanceList } from "./provenance-chip";
import { RiskBadge } from "./risk-badge";
import { StatusRail } from "./status-rail";
import { AuditTrail } from "./audit-trail";

export interface ApprovalSheetProps {
  detail: ApprovalDetail | null;
  loading?: boolean;
  error?: string | null;
  busy?: boolean;
  decisionError?: string | null;
  onApprove?: () => void;
  onReject?: () => void;
  onRevise?: () => void;
  onAskAgent?: () => void;
  className?: string;
}

function stateOf(detail: ApprovalDetail): "draft" | "confirmed" | "rejected" | "failed" {
  switch (detail.draft.state) {
    case "DRAFT":
      return "draft";
    case "REJECTED":
      return "rejected";
    case "FAILED":
      return "failed";
    default:
      return "confirmed";
  }
}

function formatQuantity(quantity: ApprovalDetail["lines"][number]["quantity"]): string {
  const unit = { meter: "米", kilogram: "公斤", yard: "码", piece: "件" }[quantity.unit];
  return `${quantity.value.toLocaleString("zh-CN")} ${unit}`;
}

/**
 * 审批卡：金额在右上角；智能体依据可点开；缺失项黄色；一个主操作（批准）。
 * 所有数据来自后端只读聚合，这里不推导金额、不判断权限。
 */
export function ApprovalSheet({
  detail,
  loading,
  error,
  busy,
  decisionError,
  onApprove,
  onReject,
  onRevise,
  onAskAgent,
  className,
}: ApprovalSheetProps) {
  if (loading) {
    return (
      <div className={cn("rounded-lg border border-line bg-surface p-8", className)}>
        <Spinner label="正在读取审批详情…" />
      </div>
    );
  }
  if (error || !detail) {
    return (
      <EmptyState
        title="这份单据暂时打不开"
        description={error ?? "审批单据不存在或已不在可查看范围。"}
      />
    );
  }

  const state = stateOf(detail);
  const pending = detail.item.pending;
  const revised = detail.draft.revisedByHuman;
  const title = detail.item.title;

  return (
    <DraftCard
      className={className}
      title={title}
      state={state}
      version={detail.draft.version}
      amount={detail.total}
      badge={
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={state === "draft" ? "info" : state === "confirmed" ? "success" : "danger"}>
            {state === "draft" ? "草稿" : state === "confirmed" ? "已批准" : "已驳回"}
          </Badge>
          <RiskBadge risk={detail.risk} />
        </span>
      }
      subtitle={
        <span>
          {detail.customer?.name ?? "客户信息不可见"} ·{" "}
          {detail.lines.length > 0
            ? `${detail.lines.length} 行 · 合计 ${detail.total ? "见右上角" : "—"}`
            : detail.item.summary}
        </span>
      }
      meta={
        <div className="flex flex-wrap items-center gap-2">
          {detail.missingFields.map((field) => (
            <MissingFieldBadge key={field.field} field={field} />
          ))}
          {revised && (
            <Badge tone="info">
              你改过 {detail.draft.revisionCount} 处 · 查看 diff
            </Badge>
          )}
        </div>
      }
      actions={
        pending ? (
          <>
            <Button variant="ghost" onClick={onReject} disabled={busy}>
              驳回
            </Button>
            <Button variant="secondary" onClick={onRevise} disabled={busy}>
              改价
            </Button>
            <Button variant="primary" onClick={onApprove} disabled={busy}>
              {busy ? "提交中…" : "批准"}
            </Button>
          </>
        ) : (
          <span className="text-xs text-ink-400">已决策，仅可查看</span>
        )
      }
    >
      <StatusRail
        steps={[
          { key: "draft", label: `草稿 v${detail.draft.version}`, status: "done" },
          {
            key: "approval",
            label: "人类审批",
            status: pending ? "current" : state === "confirmed" ? "done" : "failed",
          },
          {
            key: "effective",
            label: "生效",
            status: state === "confirmed" ? "done" : "todo",
          },
        ]}
      />

      {detail.lines.length > 0 && (
        <div className="overflow-hidden rounded-md border border-line">
          <table className="w-full text-sm">
            <thead className="bg-paper text-xs text-ink-400">
              <tr>
                <th className="px-3 py-2 text-left font-normal">品名</th>
                <th className="px-3 py-2 text-right font-normal">数量</th>
                <th className="px-3 py-2 text-right font-normal">单价</th>
                <th className="px-3 py-2 text-right font-normal">小计</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {detail.lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-3 py-2 text-ink-900">{line.description}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink-700">
                    {formatQuantity(line.quantity)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <MoneyText money={line.unitPrice} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <MoneyText money={line.lineTotal} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-line bg-paper/50">
              <tr>
                <td colSpan={3} className="px-3 py-2 text-right text-xs text-ink-400">
                  合计（后端计算）
                </td>
                <td className="px-3 py-2 text-right">
                  <MoneyText money={detail.total} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <section>
        <h4 className="mb-2 text-[13px] font-medium text-ink-900">智能体依据 / 生效值来源</h4>
        <ProvenanceList entries={detail.provenance} />
      </section>

      {detail.diffs.length > 0 && (
        <section>
          <h4 className="mb-2 text-[13px] font-medium text-ink-900">改幅 diff</h4>
          <div className="grid gap-2">
            {detail.diffs.map((diff, index) => (
              <DiffRow key={`${diff.field}-${index}`} diff={diff} />
            ))}
          </div>
        </section>
      )}

      {detail.audit.length > 0 && (
        <details className="rounded-md border border-line bg-surface px-3 py-2">
          <summary className="cursor-pointer list-none text-[13px] text-ink-700">审计流水</summary>
          <div className="mt-2 border-t border-line pt-2">
            <AuditTrail entries={detail.audit} />
          </div>
        </details>
      )}

      {decisionError && <p className="text-sm text-vermilion-600">{decisionError}</p>}

      {onAskAgent && (
        <button
          type="button"
          onClick={onAskAgent}
          className="self-start text-xs text-indigo-600 underline underline-offset-2"
        >
          让小织解释这份草稿
        </button>
      )}
    </DraftCard>
  );
}
