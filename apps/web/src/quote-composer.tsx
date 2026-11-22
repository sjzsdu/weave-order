"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  centsToYuanInput,
  parseCustomerText,
  quoteToolNotice,
  requestNotice,
  useCustomers,
} from "@weave-order/core";
import type { NoticeContext, QuoteNotice } from "@weave-order/core";
import type { QuoteDraft, QuoteStatus, SpecMatch, Unit } from "@weave-order/schema";
import { weightLabel } from "@weave-order/schema";
import { Badge, Button, Spinner, cn, formatMoney } from "@weave-order/ui";
import { useApi } from "@/providers";
import { SharePanel } from "@/share-panel";
import { STATUS_LABEL } from "@/format";

const UNIT_LABEL: Record<Unit, string> = {
  meter: "米",
  kilogram: "公斤",
  yard: "码",
  piece: "件",
};

const UNITS: Unit[] = ["meter", "kilogram", "yard", "piece"];

type ComposerMode = "create" | "draft";

export interface ComposerTemplate {
  key: string;
  label: string;
  validityDays: number;
  remarks: string;
}

/** 内置模板：没有自定义模板前，至少让「标准 14 天报价」一键可达。 */
export const BUILTIN_TEMPLATES: ComposerTemplate[] = [
  {
    key: "standard-14",
    label: "标准报价 · 14 天有效",
    validityDays: 14,
    remarks: "价格含税，有效期 14 天；大货交期以确认后回签为准。",
  },
  {
    key: "sample-first",
    label: "先寄样再报价 · 30 天有效",
    validityDays: 30,
    remarks: "先寄米样确认手感与色差，确认后 3 个工作日内出正式报价。",
  },
];

/**
 * 桌面报价 composer（WAN-175）。
 *
 * 领域逻辑不复制移动端：槽位解析（`parseCustomerText`）、报价错误文案
 * （`quoteToolNotice`）、建议价与改稿全部走 `@weave-order/core` 与内核，
 * 这里只负责桌面端的结构化表单与表格。
 */
export function QuoteComposer({
  initialQuoteId,
  initialTemplate,
  onClose,
  onSaved,
}: {
  initialQuoteId?: string | null;
  initialTemplate?: ComposerTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const customers = useCustomers(api, 100);
  const [mode, setMode] = useState<ComposerMode>(initialQuoteId ? "draft" : "create");
  const [loading, setLoading] = useState(Boolean(initialQuoteId));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<QuoteNotice | null>(null);

  // 结构化表单
  const [raw, setRaw] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SpecMatch[]>([]);
  const [sampleId, setSampleId] = useState("");
  const [quantity, setQuantity] = useState("500");
  const [unit, setUnit] = useState<Unit>("meter");
  const [unitPrice, setUnitPrice] = useState("");
  const [priceHint, setPriceHint] = useState<string | null>(null);
  const [validityDays, setValidityDays] = useState(String(initialTemplate?.validityDays ?? 14));
  const [remarks, setRemarks] = useState(initialTemplate?.remarks ?? "");
  const [suggesting, setSuggesting] = useState(false);

  // 草稿态
  const [draft, setDraft] = useState<QuoteDraft | null>(null);
  const [status, setStatus] = useState<QuoteStatus>("DRAFT");
  const [version, setVersion] = useState(1);
  const [prices, setPrices] = useState<Record<number, string>>({});
  const [shareOpen, setShareOpen] = useState(false);

  const selectedCustomer = useMemo(
    () => (customers.data ?? []).find((entry) => entry.id === customerId) ?? null,
    [customers.data, customerId],
  );
  const selectedSample = useMemo(
    () => matches.find((entry) => entry.sample.id === sampleId)?.sample ?? null,
    [matches, sampleId],
  );

  useEffect(() => {
    if (customerId || !customers.data?.[0]) return;
    setCustomerId(customers.data[0].id);
  }, [customerId, customers.data]);

  useEffect(() => {
    if (!initialQuoteId) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const detail = await api.quote(initialQuoteId);
        if (cancelled) return;
        setDraft(detail.draft);
        setStatus(detail.status);
        setVersion(detail.version);
        setCustomerId(detail.draft.customerId);
        setPrices(
          Object.fromEntries(
            detail.draft.items.map((item) => [item.lineIndex ?? 0, centsToYuanInput(item.unitPrice.amount)]),
          ),
        );
      } catch (cause) {
        if (!cancelled) setNotice(requestNotice(cause, "报价加载失败"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [api, initialQuoteId]);

  function parse() {
    const result = parseCustomerText(raw, customers.data ?? [], {
      selectedCustomerId: customerId,
    });
    if (result.customerId) setCustomerId(result.customerId);
    if (result.quantity) {
      setQuantity(String(result.quantity.value));
      setUnit(result.quantity.unit);
    }
    if (result.targetPriceCents !== null) {
      setUnitPrice(centsToYuanInput(result.targetPriceCents));
    }
    setQuery(result.query);
    setNotice({
      title: result.hits.length > 0 ? `听懂了：${result.hits.join(" · ")}` : "没听出关键信息",
      detail:
        result.missing.length > 0
          ? `还缺：${result.missing.join("、")}。补齐后可以找样或直接生成草稿。`
          : "信息齐了，点「找样」或直接填单价生成草稿。",
    });
  }

  async function findSamples() {
    const text = query.trim() || raw.trim();
    if (!text) {
      setNotice({ title: "先写要找什么", detail: "例如「棉 220g」或客户原话。" });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.searchBySpec({ query: text, limit: 8 });
      if (!result.ok) {
        setNotice(quoteToolNotice(result.error));
        return;
      }
      setMatches(result.data.matches);
      const first = result.data.matches[0]?.sample;
      if (first) {
        setSampleId(first.id);
        setUnit(first.unit);
      } else {
        setNotice({ title: "没有匹配的面料", detail: "换个说法（成分 / 克重 / 编号）再试。" });
      }
    } catch (cause) {
      setNotice(requestNotice(cause, "找样失败"));
    } finally {
      setBusy(false);
    }
  }

  async function suggestPrice() {
    if (!customerId || !selectedSample) {
      setNotice({ title: "先选客户和面料", detail: "建议单价要绑定具体客户与面料，成本不同价也不同。" });
      return;
    }
    const quantityValue = Number(quantity);
    if (!Number.isFinite(quantityValue) || quantityValue <= 0) {
      setNotice({ title: "数量要大于 0" });
      return;
    }
    setSuggesting(true);
    setNotice(null);
    try {
      const result = await api.suggestLinePrice({
        customerId,
        fabricSampleId: selectedSample.id,
        quantity: { value: quantityValue, unit },
        currency: "CNY",
      });
      if (!result.ok) {
        const ctx: NoticeContext = { unitLabel: UNIT_LABEL[selectedSample.unit] };
        setNotice(quoteToolNotice(result.error, ctx));
        return;
      }
      const pricing = result.data.pricing;
      setUnitPrice(centsToYuanInput(pricing.suggestedUnitPrice.amount));
      setPriceHint(
        `建议 ${formatMoney(pricing.suggestedUnitPrice)}/${UNIT_LABEL[selectedSample.unit]}（${pricing.components
          .map((component) => component.label)
          .join(" + ")}，可改）`,
      );
    } catch (cause) {
      setNotice(requestNotice(cause, "报价助手暂时给不出建议价"));
    } finally {
      setSuggesting(false);
    }
  }

  async function generate() {
    if (!customerId || !selectedSample) {
      setNotice({ title: "先选客户和面料", detail: "报价至少需要一位客户和一块面料。" });
      return;
    }
    const quantityValue = Number(quantity);
    if (!Number.isFinite(quantityValue) || quantityValue <= 0) {
      setNotice({ title: "数量要大于 0" });
      return;
    }
    const match = /^\d+(?:\.\d{0,2})?$/.exec(unitPrice.trim());
    const cents = match ? Math.round(Number(match[0]) * 100) : null;
    if (cents === null || cents <= 0) {
      setNotice({
        title: "请填写单价（元）",
        detail: "不知道报多少，可以点「建议单价」让报价助手算一个合规价。",
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.generateQuoteDraft({
        customerId,
        items: [
          {
            fabricSampleId: selectedSample.id,
            quantity: { value: quantityValue, unit },
            unitPrice: { amount: cents, currency: "CNY" },
            ...(query.trim() ? { notes: `检索词：${query.trim()}` } : {}),
          },
        ],
        currency: "CNY",
        validityDays: Math.max(1, Math.min(365, Number(validityDays) || 14)),
        ...(remarks.trim() ? { remarks: remarks.trim().slice(0, 2000) } : {}),
      });
      if (!result.ok) {
        setNotice(quoteToolNotice(result.error, { unitLabel: UNIT_LABEL[selectedSample.unit] }));
        return;
      }
      const next = result.data.draft;
      setDraft(next);
      setStatus("DRAFT");
      setVersion(1);
      setPrices(
        Object.fromEntries(
          next.items.map((item) => [item.lineIndex ?? 0, centsToYuanInput(item.unitPrice.amount)]),
        ),
      );
      setMode("draft");
      onSaved();
    } catch (cause) {
      setNotice(requestNotice(cause, "生成草稿失败"));
    } finally {
      setBusy(false);
    }
  }

  async function revise(lineIndex: number) {
    if (!draft) return;
    const input = prices[lineIndex] ?? "";
    const match = /^\d+(?:\.\d{0,2})?$/.exec(input.trim());
    const amount = match ? Math.round(Number(match[0]) * 100) : null;
    const line = draft.items[lineIndex];
    if (!line) return;
    if (amount === null || amount <= 0) {
      setNotice({ title: "单价格式不对（最多两位小数）" });
      return;
    }
    if (amount === line.unitPrice.amount) {
      setNotice({ title: "单价没有变化" });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.reviseQuote({
        quoteId: draft.id,
        baseVersion: version,
        source: "INLINE",
        instruction: `桌面工作台改价 ${formatMoney(line.unitPrice)} → ${formatMoney({
          amount,
          currency: draft.currency,
        })}`,
        lines: [{ lineIndex, unitPrice: { amount, currency: draft.currency } }],
      });
      if (!result.ok) {
        setNotice(quoteToolNotice(result.error));
        return;
      }
      setDraft(result.data.draft);
      setVersion(result.data.draft.version);
      setPrices(
        Object.fromEntries(
          result.data.draft.items.map((item) => [
            item.lineIndex ?? 0,
            centsToYuanInput(item.unitPrice.amount),
          ]),
        ),
      );
      onSaved();
    } catch (cause) {
      setNotice(requestNotice(cause, "改价失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/40 p-4 py-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="报价编辑"
        className="w-full max-w-3xl rounded-lg border border-line bg-surface shadow-card"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">
              {mode === "create" ? "新建报价" : "报价草稿"}
            </p>
            <h2 className="mt-0.5 text-lg font-semibold text-ink-900">
              {mode === "create"
                ? "结构化编辑一单报价"
                : `${selectedCustomer?.name ?? draft?.customerId.slice(0, 8) ?? "报价"} · ${
                    STATUS_LABEL[status] ?? status
                  }`}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {mode === "draft" && draft ? (
              <Badge tone={status === "DRAFT" ? "warning" : "success"}>
                {STATUS_LABEL[status] ?? status}
              </Badge>
            ) : null}
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
          </div>
        </header>

        <div className="grid gap-4 px-5 py-4">
          {notice ? (
            <div className="rounded-md border border-line bg-paper px-3 py-2">
              <p className="text-sm font-medium text-ink-900">{notice.title}</p>
              {notice.detail ? <p className="mt-0.5 text-xs text-ink-500">{notice.detail}</p> : null}
            </div>
          ) : null}

          {loading ? <Spinner label="读取报价…" /> : null}

          {!loading && mode === "create" ? (
            <>
              <section className="grid gap-3 rounded-md border border-line px-3 py-3">
                <label className="grid gap-1 text-xs text-ink-400">
                  客户原话（可选：粘进来点「解析」自动填）
                  <textarea
                    value={raw}
                    onChange={(event) => setRaw(event.target.value)}
                    rows={2}
                    placeholder="青禾要 300 米 涤棉 180g，15 块能做吗"
                    className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={parse} disabled={!raw.trim()}>
                    解析原话
                  </Button>
                </div>
              </section>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-xs text-ink-400">
                  客户
                  <select
                    value={customerId}
                    onChange={(event) => setCustomerId(event.target.value)}
                    className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900"
                  >
                    <option value="">选择客户</option>
                    {(customers.data ?? []).map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs text-ink-400">
                  有效期（天）
                  <input
                    inputMode="numeric"
                    value={validityDays}
                    onChange={(event) => setValidityDays(event.target.value)}
                    className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900"
                  />
                </label>
              </div>

              <section className="grid gap-2 rounded-md border border-line px-3 py-3">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="grid flex-1 gap-1 text-xs text-ink-400">
                    找样
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="成分 / 克重 / 编号，例如 棉 220g"
                      className="min-w-48 rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900"
                    />
                  </label>
                  <Button variant="secondary" onClick={() => void findSamples()} disabled={busy}>
                    找样
                  </Button>
                </div>
                {matches.length > 0 ? (
                  <ul className="grid gap-1">
                    {matches.map((match) => {
                      const selected = match.sample.id === sampleId;
                      return (
                        <li key={match.sample.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setSampleId(match.sample.id);
                              setUnit(match.sample.unit);
                            }}
                            className={cn(
                              "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm",
                              selected
                                ? "border-indigo-600 bg-indigo-100/40"
                                : "border-line hover:border-ink-400",
                            )}
                          >
                            <span>
                              <span className="font-medium text-ink-900">{match.sample.name}</span>
                              <span className="ml-2 text-xs text-ink-400">
                                {match.sample.code} · {match.sample.composition ?? "成分未填"} ·{" "}
                                {weightLabel(match.sample.weight) ?? "克重未填"}
                              </span>
                            </span>
                            <span className="text-xs text-ink-400">
                              {match.matchedOn.join(" / ")}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </section>

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="grid gap-1 text-xs text-ink-400">
                  数量
                  <input
                    inputMode="decimal"
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900"
                  />
                </label>
                <label className="grid gap-1 text-xs text-ink-400">
                  计价单位
                  <select
                    value={unit}
                    onChange={(event) => setUnit(event.target.value as Unit)}
                    className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900"
                  >
                    {UNITS.map((entry) => (
                      <option key={entry} value={entry}>
                        {UNIT_LABEL[entry]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs text-ink-400">
                  单价（元 / {UNIT_LABEL[unit]}）
                  <div className="flex gap-2">
                    <input
                      inputMode="decimal"
                      value={unitPrice}
                      onChange={(event) => setUnitPrice(event.target.value)}
                      className="min-w-0 flex-1 rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900"
                    />
                    <Button
                      variant="secondary"
                      onClick={() => void suggestPrice()}
                      disabled={suggesting}
                    >
                      {suggesting ? "算价中…" : "建议单价"}
                    </Button>
                  </div>
                </label>
              </div>
              {priceHint ? <p className="text-xs text-ink-500">{priceHint}</p> : null}

              <label className="grid gap-1 text-xs text-ink-400">
                备注
                <textarea
                  value={remarks}
                  onChange={(event) => setRemarks(event.target.value)}
                  rows={2}
                  className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900"
                />
              </label>

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>
                  取消
                </Button>
                <Button variant="primary" onClick={() => void generate()} disabled={busy}>
                  {busy ? "生成中…" : "生成草稿"}
                </Button>
              </div>
            </>
          ) : null}

          {!loading && mode === "draft" && draft ? (
            <>
              <div className="grid gap-2 rounded-md border border-line px-3 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-ink-500">合计</span>
                  <span className="text-lg font-semibold text-ink-900">
                    {formatMoney(draft.total)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-400">
                  <span>版本 v{version}</span>
                  <span>有效期至 {new Date(draft.expiresAt).toLocaleDateString("zh-CN")}</span>
                  <span>{draft.items.length} 行</span>
                </div>
              </div>

              <div className="overflow-x-auto rounded-md border border-line">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="bg-paper text-xs text-ink-400">
                    <tr>
                      <th className="px-3 py-2 text-left font-normal">面料</th>
                      <th className="px-3 py-2 text-right font-normal">数量</th>
                      <th className="px-3 py-2 text-right font-normal">单价</th>
                      <th className="px-3 py-2 text-right font-normal">小计</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {draft.items.map((item, index) => {
                      const lineIndex = item.lineIndex ?? index;
                      const editable = status === "DRAFT";
                      return (
                        <tr key={`${item.fabricSampleId}-${lineIndex}`}>
                          <td className="px-3 py-2">
                            <span className="text-ink-900">{item.description}</span>
                          </td>
                          <td className="px-3 py-2 text-right text-xs text-ink-700">
                            {item.quantity.value} {UNIT_LABEL[item.quantity.unit]}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {editable ? (
                              <span className="inline-flex items-center gap-1">
                                <input
                                  inputMode="decimal"
                                  value={prices[lineIndex] ?? ""}
                                  onChange={(event) =>
                                    setPrices((current) => ({
                                      ...current,
                                      [lineIndex]: event.target.value,
                                    }))
                                  }
                                  className="w-24 rounded-md border border-line bg-paper px-2 py-1 text-right text-xs"
                                />
                                <button
                                  type="button"
                                  onClick={() => void revise(lineIndex)}
                                  disabled={busy}
                                  className="text-xs text-indigo-600 underline underline-offset-2 disabled:opacity-60"
                                >
                                  保存
                                </button>
                              </span>
                            ) : (
                              <span className="text-xs">{formatMoney(item.unitPrice)}</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right text-xs">
                            {formatMoney(item.lineTotal)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {draft.remarks ? (
                <p className="rounded-md bg-paper px-3 py-2 text-xs text-ink-500">{draft.remarks}</p>
              ) : null}

              <div className="flex flex-wrap justify-end gap-2">
                {status === "DRAFT" ? (
                  <Link
                    href="/approvals"
                    className="inline-flex min-h-9 items-center rounded-md border border-line px-4 text-sm text-ink-700 hover:border-ink-400"
                  >
                    去审批 / 发送
                  </Link>
                ) : null}
                <Button variant="primary" onClick={() => setShareOpen(true)}>
                  分享给客户
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDraft(null);
                    setMode("create");
                    setNotice(null);
                  }}
                >
                  再报一单
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {shareOpen && draft ? (
        <SharePanel
          quoteId={draft.id}
          title={`报价 · ${selectedCustomer?.name ?? "客户"}`}
          onClose={() => setShareOpen(false)}
        />
      ) : null}
    </div>
  );
}
