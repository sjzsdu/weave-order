import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import type { ApprovalDecision, ApprovalItem, QuoteSendRecord } from "@weave-order/schema";
import { customerName, messageOf, statusBadgeClass, timeLabel, toolErrorText } from "../lib";
import { exportQuotePdf, listQuoteSends } from "../quoteExport";
import { useAppStore } from "../store";
import { BADGE_BASE, BTN_DANGER, BTN_GHOST, BTN_PRIMARY, CARD, INPUT } from "../ui";

interface PendingDecision {
  item: ApprovalItem;
  decision: ApprovalDecision;
}

function kindLabel(kind: ApprovalItem["kind"]): string {
  return kind === "quote" ? "报价草稿" : "寄样单草稿";
}

/** 一条发送记录的人话摘要：渠道 · 接收方 · 时间。 */
function sendSummary(send: QuoteSendRecord): string {
  const channel = send.channel === "MANUAL_EXPORT" ? "人工导出" : send.channel;
  const recipient = send.recipient ? ` → ${send.recipient}` : " → 未填写接收方";
  return `${channel}${recipient} · ${timeLabel(send.createdAt)}`;
}

/**
 * 窗口二 · Review Queue（审批与异常分诊）。
 *
 * 批准/拒绝是前端唯一的人类决策入口，且只走 approval API（/api/approvals/decide）；
 * 生效动作由 approval 服务调内核 confirm/reject 完成，前端不直连内核、不写业务表。
 * 驳回可带分诊备注（记入审计），并在本会话台账与全景窗口体现「异常分诊」。
 *
 * 报价批准后还要能「交出去」：导出 PDF 由后端渲染并写发送记录，
 * 界面只在真的存在发送记录时才显示「已发送」——`SENT` 只代表已确认，不代表客户收到了。
 */
export function ReviewQueue() {
  const queue = useAppStore((s) => s.queue);
  const decisions = useAppStore((s) => s.decisions);
  const customers = useAppStore((s) => s.customers);
  const decide = useAppStore((s) => s.decide);
  const refresh = useAppStore((s) => s.refresh);

  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** 每份已批准报价的发送记录；没有条目 = 还没查/还没发过。 */
  const [sends, setSends] = useState<Record<string, QuoteSendRecord[]>>({});
  const [exportTarget, setExportTarget] = useState<{ id: string; title: string } | null>(null);
  const [recipient, setRecipient] = useState("");
  const [exportNote, setExportNote] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const approvedQuoteIds = decisions
    .filter((record) => record.kind === "quote" && record.decision === "APPROVE")
    .map((record) => record.id);

  useEffect(() => {
    if (approvedQuoteIds.length === 0) return;
    let cancelled = false;
    void Promise.all(
      approvedQuoteIds.map(async (id) => [id, await listQuoteSends(id)] as const),
    )
      .then((entries) => {
        if (cancelled) return;
        setSends((previous) => ({ ...previous, ...Object.fromEntries(entries) }));
      })
      .catch(() => {
        // 读不到发送记录就不显示「已发送」：宁可不显示，也不猜。
      });
    return () => {
      cancelled = true;
    };
  }, [decisions]);

  const openDecision = (item: ApprovalItem, decision: ApprovalDecision) => {
    setError(null);
    setNote("");
    setPending({ item, decision });
  };

  const confirmDecision = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const result = await decide({
        id: pending.item.id,
        kind: pending.item.kind,
        decision: pending.decision,
        ...(pending.decision === "REJECT" && note.trim() ? { note: note.trim() } : {}),
      });
      if (!result.ok) {
        setError(toolErrorText(result.error));
        return;
      }
      setNotice(
        `${pending.decision === "APPROVE" ? "已批准" : "已驳回"} · ${pending.item.title} → ${result.data.status}（actor=${result.data.actorType}）`,
      );
      setPending(null);
      setNote("");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const openExport = (id: string, title: string) => {
    setExportError(null);
    setRecipient("");
    setExportNote("");
    setExportTarget({ id, title });
  };

  const runExport = async () => {
    if (!exportTarget) return;
    setExporting(true);
    setExportError(null);
    try {
      await exportQuotePdf(exportTarget.id, { recipient, note: exportNote });
      const records = await listQuoteSends(exportTarget.id);
      setSends((previous) => ({ ...previous, [exportTarget.id]: records }));
      setExportNotice(
        `已导出并记录发送 · ${exportTarget.title} · 共 ${records.length} 次发送记录`,
      );
      setExportTarget(null);
    } catch (caught) {
      setExportError(messageOf(caught));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="grid gap-5">
      <div className={CARD}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <h2 className="text-lg font-semibold text-text">
              审批与异常分诊{" "}
              <span className="text-sm font-normal text-muted">· 待审批 {queue.length}</span>
            </h2>
            <p className="mt-1 text-sm text-muted">
              智能体产出一律草稿 / 建议。批准 → approval API → 内核 confirm 生效；驳回 →
              拒绝并分诊。 本窗口是人类唯一决策入口，前端不会绕过 tools 直连内核。
            </p>
          </div>
          <button type="button" className={BTN_GHOST} onClick={() => void refresh()}>
            刷新
          </button>
        </div>

        {notice && (
          <p className="mt-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent">
            ✓ {notice}
          </p>
        )}

        {queue.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">
            暂无待审批草稿。到「任务派发」窗口派发一个意图，或先运行 <code>pnpm demo</code>。
          </div>
        ) : (
          <div className="mt-4 grid gap-3">
            {queue.map((item) => (
              <article key={item.id} className="rounded-xl border border-line bg-[#11161c] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`${BADGE_BASE} border-warn/60 bg-warn/10 text-warn`}>
                        {kindLabel(item.kind)}
                      </span>
                      <span className={`${BADGE_BASE} ${statusBadgeClass(item.status)}`}>
                        {item.status}
                      </span>
                    </div>
                    <h3 className="mt-2 text-sm font-semibold text-text">{item.title}</h3>
                    <p className="mt-0.5 text-xs text-muted">
                      {customerName(customers, item.customerId)} · {item.summary} ·{" "}
                      {timeLabel(item.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      className={BTN_PRIMARY}
                      disabled={busy}
                      onClick={() => openDecision(item, "APPROVE")}
                    >
                      批准
                    </button>
                    <button
                      type="button"
                      className={BTN_DANGER}
                      disabled={busy}
                      onClick={() => openDecision(item, "REJECT")}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className={CARD}>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-base font-semibold text-text">最近决策（本会话 · 异常分诊台账）</h3>
          <span className="wo-kicker">{decisions.length} 条</span>
        </div>
        {exportNotice && (
          <p className="mt-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent">
            ✓ {exportNotice}
          </p>
        )}
        {decisions.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            还没有决策。批准 / 拒绝后会记录在这里，并在全景只读窗口反映到账本状态。
          </p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {decisions.map((record, index) => {
              const isApprovedQuote = record.kind === "quote" && record.decision === "APPROVE";
              const quoteSends = sends[record.id] ?? [];
              return (
                <li
                  key={`${record.id}-${index}`}
                  className="rounded-lg border border-line bg-[#11161c] px-3 py-2 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-text">{record.title}</span>
                    <div className="flex flex-wrap items-center gap-2">
                      {isApprovedQuote && (
                        <span
                          className={`${BADGE_BASE} ${
                            quoteSends.length > 0
                              ? "border-accent/60 bg-accent/10 text-accent"
                              : "border-line bg-[#151d26] text-muted"
                          }`}
                        >
                          {quoteSends.length > 0
                            ? `已发送 ${quoteSends.length} 次`
                            : "未发送 · 尚无导出记录"}
                        </span>
                      )}
                      <span
                        className={`${BADGE_BASE} ${
                          record.decision === "APPROVE"
                            ? "border-accent/60 bg-accent/10 text-accent"
                            : "border-danger/60 bg-danger/10 text-danger"
                        }`}
                      >
                        {record.decision === "APPROVE" ? "批准" : "驳回"} → {record.status}
                      </span>
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted">
                      {timeLabel(record.at)}
                      {record.note ? ` · 备注：${record.note}` : ""}
                    </span>
                    {isApprovedQuote && (
                      <button
                        type="button"
                        className={BTN_GHOST}
                        onClick={() => openExport(record.id, record.title)}
                      >
                        导出报价单 PDF
                      </button>
                    )}
                  </div>
                  {isApprovedQuote && quoteSends.length > 0 && (
                    <ul className="mt-2 grid gap-1 border-t border-line pt-2">
                      {quoteSends.slice(0, 3).map((send) => (
                        <li key={send.id} className="text-xs text-muted">
                          发送记录 · {sendSummary(send)} · 版本 {send.snapshotHash.slice(0, 8)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog.Root
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPending(null);
            setError(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
          <Dialog.Content
            className={`${CARD} fixed left-1/2 top-1/2 z-50 w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 shadow-2xl`}
          >
            <Dialog.Title className="text-base font-semibold text-text">
              {pending?.decision === "APPROVE" ? "确认批准" : "确认驳回（异常分诊）"}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted">
              铁律 #2：批准后由内核 confirm 落账（actor = HUMAN，不可撤销）；智能体无权确认。
              驳回会把 DRAFT 置为 REJECTED / CANCELLED 并写审计。
            </Dialog.Description>

            {pending && (
              <div className="mt-4 rounded-lg border border-line bg-[#11161c] p-3 text-sm">
                <p className="font-semibold text-text">
                  {pending.item.title} · {pending.item.status}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {kindLabel(pending.item.kind)} · {pending.item.summary}
                </p>
              </div>
            )}

            {pending?.decision === "REJECT" && (
              <label className="mt-4 grid gap-1.5">
                <span className="wo-kicker">驳回 / 分诊备注（可选，记入审计）</span>
                <textarea
                  className={INPUT}
                  rows={3}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="例如：价格低于成本底线 / 客户信息不全"
                />
              </label>
            )}

            {error && <p className="mt-3 text-sm text-danger">{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className={BTN_GHOST}>
                  取消
                </button>
              </Dialog.Close>
              <button
                type="button"
                className={pending?.decision === "APPROVE" ? BTN_PRIMARY : BTN_DANGER}
                disabled={busy}
                onClick={() => void confirmDecision()}
              >
                {busy ? "提交中…" : pending?.decision === "APPROVE" ? "确认批准" : "确认驳回"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={exportTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setExportTarget(null);
            setExportError(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
          <Dialog.Content
            className={`${CARD} fixed left-1/2 top-1/2 z-50 w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 shadow-2xl`}
          >
            <Dialog.Title className="text-base font-semibold text-text">导出报价单</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted">
              浏览器会下载一份含客户名、明细、总额与有效期的 PDF。导出即记一次「已发送」：
              谁、何时、什么渠道、发给谁、哪一版内容快照都会落到账本里。
            </Dialog.Description>

            {exportTarget && (
              <div className="mt-4 rounded-lg border border-line bg-[#11161c] p-3 text-sm">
                <p className="font-semibold text-text">{exportTarget.title}</p>
              </div>
            )}

            <label className="mt-4 grid gap-1.5">
              <span className="wo-kicker">发给谁（客户联系人 / 微信 / 邮箱，可留空）</span>
              <input
                className={INPUT}
                value={recipient}
                onChange={(event) => setRecipient(event.target.value)}
                placeholder="例如：王经理 / 微信 wxid_xxx / wang@example.com"
              />
            </label>

            <label className="mt-3 grid gap-1.5">
              <span className="wo-kicker">发送备注（可选，记入发送记录）</span>
              <input
                className={INPUT}
                value={exportNote}
                onChange={(event) => setExportNote(event.target.value)}
                placeholder="例如：客户催了 3 次，先发这一版"
              />
            </label>

            {exportError && <p className="mt-3 text-sm text-danger">{exportError}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className={BTN_GHOST}>
                  取消
                </button>
              </Dialog.Close>
              <button
                type="button"
                className={BTN_PRIMARY}
                disabled={exporting}
                onClick={() => void runExport()}
              >
                {exporting ? "导出中…" : "导出并记录发送"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
