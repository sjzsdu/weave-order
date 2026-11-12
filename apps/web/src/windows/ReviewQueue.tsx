import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import type { ApprovalDecision, ApprovalItem } from "@weave-order/schema";
import { customerName, messageOf, statusBadgeClass, timeLabel, toolErrorText } from "../lib";
import { useAppStore } from "../store";
import { BADGE_BASE, BTN_DANGER, BTN_GHOST, BTN_PRIMARY, CARD, INPUT } from "../ui";

interface PendingDecision {
  item: ApprovalItem;
  decision: ApprovalDecision;
}

function kindLabel(kind: ApprovalItem["kind"]): string {
  return kind === "quote" ? "报价草稿" : "寄样单草稿";
}

/**
 * 窗口二 · Review Queue（审批与异常分诊）。
 *
 * 批准/拒绝是前端唯一的人类决策入口，且只走 approval API（/api/approvals/decide）；
 * 生效动作由 approval 服务调内核 confirm/reject 完成，前端不直连内核、不写业务表。
 * 驳回可带分诊备注（记入审计），并在本会话台账与全景窗口体现「异常分诊」。
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
        {decisions.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            还没有决策。批准 / 拒绝后会记录在这里，并在全景只读窗口反映到账本状态。
          </p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {decisions.map((record, index) => (
              <li
                key={`${record.id}-${index}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-[#11161c] px-3 py-2 text-sm"
              >
                <span className="text-text">{record.title}</span>
                <span
                  className={`${BADGE_BASE} ${
                    record.decision === "APPROVE"
                      ? "border-accent/60 bg-accent/10 text-accent"
                      : "border-danger/60 bg-danger/10 text-danger"
                  }`}
                >
                  {record.decision === "APPROVE" ? "批准" : "驳回"} → {record.status}
                </span>
                <span className="text-xs text-muted">
                  {timeLabel(record.at)}
                  {record.note ? ` · 备注：${record.note}` : ""}
                </span>
              </li>
            ))}
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
    </section>
  );
}
