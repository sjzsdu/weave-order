import { useState } from "react";
import type {
  Currency,
  T002SearchFabricBySpecInput,
  T004GenerateQuoteDraftInput,
  T005CreateSampleShipmentInput,
} from "@weave-order/schema";
import { formatCents, messageOf, shortId, toolErrorText } from "../lib";
import { useAppStore } from "../store";
import { BTN_INTENT, CARD, INPUT, SELECT } from "../ui";

interface Outcome {
  ok: boolean;
  text: string;
  detail?: string;
}

/**
 * 窗口一 · Intent Bar（任务派发）。
 *
 * 只选上下文、派发意图，不逐条录入业务数据；每个按钮把一条业务意图交给
 * 智能体的工具去执行，产出永远停在 DRAFT / 建议态。草稿生效必须去审批窗口。
 */
export function IntentBar() {
  const customers = useAppStore((s) => s.customers);
  const samples = useAppStore((s) => s.samples);
  const generateQuoteDraft = useAppStore((s) => s.generateQuoteDraft);
  const createSampleShipment = useAppStore((s) => s.createSampleShipment);
  const searchBySpec = useAppStore((s) => s.searchBySpec);

  const [customerId, setCustomerId] = useState("");
  const [sampleId, setSampleId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const effectiveCustomerId = customerId || customers[0]?.id || "";
  const effectiveSampleId = sampleId || samples[0]?.id || "";
  const customer = customers.find((item) => item.id === effectiveCustomerId) ?? null;
  const sample = samples.find((item) => item.id === effectiveSampleId) ?? null;
  const seeded = customer !== null && sample !== null;

  const run = async (fn: () => Promise<Outcome>) => {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await fn());
    } catch (error) {
      setOutcome({ ok: false, text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const dispatchQuote = () =>
    void run(async () => {
      if (!customer || !sample) return { ok: false, text: "请先准备客户与样品（运行 pnpm demo）" };
      const currency: Currency = sample.costFloor?.currency ?? "CNY";
      const unitPriceAmount = (sample.costFloor?.amount ?? 1200) + 300;
      const body: T004GenerateQuoteDraftInput = {
        customerId: customer.id,
        currency,
        validityDays: 30,
        remarks: note.trim() || "Intent Bar 派发：报价草稿",
        items: [
          {
            fabricSampleId: sample.id,
            quantity: { value: 120.5, unit: sample.unit },
            unitPrice: { amount: unitPriceAmount, currency },
          },
        ],
      };
      const result = await generateQuoteDraft(body);
      if (!result.ok) return { ok: false, text: toolErrorText(result.error) };
      const draft = result.data.draft;
      return {
        ok: true,
        text: `已派发：智能体产出 DRAFT 报价单 ${shortId(draft.id)}`,
        detail: `${formatCents(draft.total.amount, draft.total.currency)} · 金额由内核计算 · 已进入审批窗口`,
      };
    });

  const dispatchShipment = () =>
    void run(async () => {
      if (!customer || !sample) return { ok: false, text: "请先准备客户与样品（运行 pnpm demo）" };
      const body: T005CreateSampleShipmentInput = {
        customerId: customer.id,
        items: [{ sampleId: sample.id, quantity: { value: 3, unit: sample.unit } }],
        channel: "COURIER",
        carrier: "顺丰",
        trackingNumber: `SF${Date.now().toString(36).toUpperCase()}`,
        note: note.trim() || "Intent Bar 派发：寄样草稿（含运单号）",
      };
      const result = await createSampleShipment(body);
      if (!result.ok) return { ok: false, text: toolErrorText(result.error) };
      const shipment = result.data.shipment;
      return {
        ok: true,
        text: `已派发：智能体产出 DRAFT 寄样单 ${shortId(shipment.id)}`,
        detail: `${shipment.items.length} 件样品 · 运单号 ${shipment.trackingNumber ?? "-"} · 已进入审批窗口`,
      };
    });

  const dispatchSearch = () =>
    void run(async () => {
      const body: T002SearchFabricBySpecInput = { query: note.trim() || "棉", limit: 8 };
      const result = await searchBySpec(body);
      if (!result.ok) return { ok: false, text: toolErrorText(result.error) };
      const matches = result.data.matches;
      return {
        ok: true,
        text: `找样（只读建议）：命中 ${matches.length} 个样品`,
        detail: matches.length
          ? matches
              .map(
                (match) =>
                  `${match.sample.code} · ${match.sample.name}（命中 ${match.matchedOn.join("/") || "-"}）`,
              )
              .join("；")
          : "没有匹配的样品，换个关键词再试",
      };
    });

  return (
    <section className="grid gap-5">
      <div className={CARD}>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold text-text">向智能体派发业务意图</h2>
          <span className="wo-kicker">Intent Bar</span>
        </div>
        <p className="mt-1 text-sm text-muted">
          只选上下文、派发意图，不逐条录入业务数据。智能体通过工具产出草稿 / 建议，一律停在{" "}
          <span className="font-semibold text-warn">DRAFT</span>，需到审批窗口由人类批准才生效（铁律
          #2）。
        </p>

        {!seeded ? (
          <div className="mt-5 rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">
            还没有客户 / 样品。先在仓库根目录执行 <code>pnpm demo</code> 造演示数据，再刷新。
          </div>
        ) : (
          <>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="wo-kicker">派发上下文 · 客户</span>
                <select
                  className={SELECT}
                  value={effectiveCustomerId}
                  onChange={(event) => setCustomerId(event.target.value)}
                >
                  {customers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}（{item.code}）
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5">
                <span className="wo-kicker">派发上下文 · 样品</span>
                <select
                  className={SELECT}
                  value={effectiveSampleId}
                  onChange={(event) => setSampleId(event.target.value)}
                >
                  {samples.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.code} · {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="mt-4 grid gap-1.5">
              <span className="wo-kicker">意图描述 / 找样关键词（可选）</span>
              <input
                className={INPUT}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="例如：给 VIP 客户出一版报价 / 100%棉"
              />
            </label>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <button
                type="button"
                className={BTN_INTENT}
                disabled={busy || !seeded}
                onClick={dispatchQuote}
              >
                <span className="text-sm font-semibold text-text">① 出报价草稿</span>
                <span className="text-xs text-muted">T-004 · 金额内核算 · 产出 DRAFT</span>
              </button>
              <button
                type="button"
                className={BTN_INTENT}
                disabled={busy || !seeded}
                onClick={dispatchShipment}
              >
                <span className="text-sm font-semibold text-text">② 建寄样单</span>
                <span className="text-xs text-muted">T-005 · 带运单号 · 产出 DRAFT</span>
              </button>
              <button type="button" className={BTN_INTENT} disabled={busy} onClick={dispatchSearch}>
                <span className="text-sm font-semibold text-text">③ 按关键词找样</span>
                <span className="text-xs text-muted">T-002 · 只读建议 · 不写账本</span>
              </button>
            </div>
            <p className="mt-3 text-xs text-muted">
              {busy
                ? "智能体正在通过工具执行…"
                : "T-004 / T-005 / T-002 均以 agent 身份调用工具；前端不直连内核、不写业务表。"}
            </p>
          </>
        )}
      </div>

      {outcome && (
        <div className={`${CARD} ${outcome.ok ? "border-accent/50" : "border-danger/50"}`}>
          <p className={`text-sm font-semibold ${outcome.ok ? "text-accent" : "text-danger"}`}>
            {outcome.ok ? "✓" : "✕"} {outcome.text}
          </p>
          {outcome.detail && (
            <p className="mt-1 break-words text-sm text-muted">{outcome.detail}</p>
          )}
          {outcome.ok && (
            <p className="mt-2 text-xs text-muted">
              草稿已进入「审批与异常分诊」窗口；批准 / 拒绝由人类决定，前端才会调内核 confirm 生效。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
