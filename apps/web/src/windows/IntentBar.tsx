import { useState } from "react";
import type {
  CreateCustomerInput,
  CreateSampleInput,
  Currency,
  T002SearchFabricBySpecInput,
  T004GenerateQuoteDraftInput,
  T005CreateSampleShipmentInput,
  Unit,
} from "@weave-order/schema";
import { formatCents, messageOf, shortId, toolErrorText } from "../lib";
import { useAppStore } from "../store";
import { BTN_GHOST, BTN_INTENT, BTN_PRIMARY, CARD, INPUT, SELECT } from "../ui";

interface Outcome {
  ok: boolean;
  text: string;
  detail?: string;
  /** 只有派发类结果才提示「草稿进入审批窗口」；主数据录入没有草稿。 */
  draft?: boolean;
}

type IntakeKind = "customer" | "sample" | null;

const TIERS: { value: NonNullable<CreateCustomerInput["tier"]>; label: string }[] = [
  { value: "VIP", label: "VIP" },
  { value: "REGULAR", label: "常规" },
  { value: "NEW", label: "新客户" },
  { value: "COLD", label: "沉睡" },
];

const UNITS: { value: Unit; label: string }[] = [
  { value: "meter", label: "米" },
  { value: "kilogram", label: "千克" },
  { value: "yard", label: "码" },
  { value: "piece", label: "件" },
];

const CURRENCIES: Currency[] = ["CNY", "USD", "EUR", "HKD"];

/** 默认编号：只求「能直接保存」，用户可以改成自己的编码规则。 */
function suggestCode(prefix: string): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  return `${prefix}-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

const BLANK_CUSTOMER: CustomerForm = {
  code: "",
  name: "",
  tier: "REGULAR",
  contactName: "",
  contactPhone: "",
};

interface CustomerForm {
  code: string;
  name: string;
  tier: NonNullable<CreateCustomerInput["tier"]>;
  contactName: string;
  contactPhone: string;
}

interface SampleForm {
  code: string;
  name: string;
  composition: string;
  weight: string;
  unit: Unit;
  costFloorYuan: string;
  currency: Currency;
}

const BLANK_SAMPLE: SampleForm = {
  code: "",
  name: "",
  composition: "",
  weight: "",
  unit: "meter",
  costFloorYuan: "",
  currency: "CNY",
};

/**
 * 窗口一 · Intent Bar（任务派发）。
 *
 * 只选上下文、派发意图，不逐条录入业务单据；每个按钮把一条业务意图交给
 * 智能体的工具去执行，产出永远停在 DRAFT / 建议态。草稿生效必须去审批窗口。
 *
 * 唯一的内联录入是「基础资料」（客户 / 样品）：空库冷启动时，没有客户和样品
 * 就没有可派发的上下文，所以这里提供一张内联卡片（不新增第四个窗口，铁律 #4）。
 * 它写的是主数据，不是账本。
 */
export function IntentBar() {
  const customers = useAppStore((s) => s.customers);
  const samples = useAppStore((s) => s.samples);
  const createCustomer = useAppStore((s) => s.createCustomer);
  const createSample = useAppStore((s) => s.createSample);
  const generateQuoteDraft = useAppStore((s) => s.generateQuoteDraft);
  const createSampleShipment = useAppStore((s) => s.createSampleShipment);
  const searchBySpec = useAppStore((s) => s.searchBySpec);

  const [customerId, setCustomerId] = useState("");
  const [sampleId, setSampleId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [intake, setIntake] = useState<IntakeKind>(null);
  const [customerForm, setCustomerForm] = useState<CustomerForm>(BLANK_CUSTOMER);
  const [sampleForm, setSampleForm] = useState<SampleForm>(BLANK_SAMPLE);

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

  const toggleCustomerForm = () => {
    setIntake(intake === "customer" ? null : "customer");
    setCustomerForm((prev) => (prev.code ? prev : { ...prev, code: suggestCode("CUS") }));
  };

  const toggleSampleForm = () => {
    setIntake(intake === "sample" ? null : "sample");
    setSampleForm((prev) => (prev.code ? prev : { ...prev, code: suggestCode("SMP") }));
  };

  const submitCustomer = () =>
    void run(async () => {
      const created = await createCustomer({
        code: customerForm.code.trim(),
        name: customerForm.name.trim(),
        tier: customerForm.tier,
        contactName: customerForm.contactName.trim() || null,
        contactPhone: customerForm.contactPhone.trim() || null,
      });
      setCustomerId(created.id);
      setCustomerForm(BLANK_CUSTOMER);
      setIntake(null);
      return {
        ok: true,
        text: `已新增客户：${created.name}（${created.code}）`,
        detail: "已自动选中为派发上下文 · 审计已记录 CUSTOMER_CREATED（HUMAN）",
      };
    });

  const submitSample = () =>
    void run(async () => {
      const yuan = sampleForm.costFloorYuan.trim();
      let costFloor: CreateSampleInput["costFloor"] = null;
      if (yuan) {
        const amount = Number(yuan);
        if (!Number.isFinite(amount) || amount < 0) {
          return { ok: false, text: "成本底线要填非负数字（单位：元）" };
        }
        costFloor = { amount: Math.round(amount * 100), currency: sampleForm.currency };
      }
      const created = await createSample({
        code: sampleForm.code.trim(),
        name: sampleForm.name.trim(),
        composition: sampleForm.composition.trim() || null,
        weight: sampleForm.weight.trim() || null,
        unit: sampleForm.unit,
        costFloor,
        status: "ACTIVE",
      });
      setSampleId(created.id);
      setSampleForm(BLANK_SAMPLE);
      setIntake(null);
      return {
        ok: true,
        text: `已新增样品：${created.code} · ${created.name}`,
        detail: `计量单位 ${created.unit} · 审计已记录 SAMPLE_CREATED（HUMAN）`,
      };
    });

  const dispatchQuote = () =>
    void run(async () => {
      if (!customer || !sample) return { ok: false, text: "请先内联新增客户与样品" };
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
        draft: true,
        text: `已派发：智能体产出 DRAFT 报价单 ${shortId(draft.id)}`,
        detail: `${formatCents(draft.total.amount, draft.total.currency)} · 金额由内核计算 · 已进入审批窗口`,
      };
    });

  const dispatchShipment = () =>
    void run(async () => {
      if (!customer || !sample) return { ok: false, text: "请先内联新增客户与样品" };
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
        draft: true,
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
          只选上下文、派发意图，不逐条录入业务单据。智能体通过工具产出草稿 / 建议，一律停在{" "}
          <span className="font-semibold text-warn">DRAFT</span>，需到审批窗口由人类批准才生效（铁律
          #2）。
        </p>

        <div className="mt-5 rounded-xl border border-dashed border-line bg-[#11161c] px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted">
              基础资料（客户 / 样品）可以在这里内联新增，空库也能直接开始 —— 不需要先跑{" "}
              <code>pnpm demo</code>。写入的是主数据，不是账本。
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={BTN_GHOST}
                disabled={busy}
                onClick={toggleCustomerForm}
              >
                ＋ 客户
              </button>
              <button
                type="button"
                className={BTN_GHOST}
                disabled={busy}
                onClick={toggleSampleForm}
              >
                ＋ 样品
              </button>
            </div>
          </div>

          {intake === "customer" && (
            <form
              className="mt-4 grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                submitCustomer();
              }}
            >
              <label className="grid gap-1.5">
                <span className="wo-kicker">客户名称 · 必填</span>
                <input
                  className={INPUT}
                  value={customerForm.name}
                  autoFocus
                  onChange={(event) =>
                    setCustomerForm({ ...customerForm, name: event.target.value })
                  }
                  placeholder="例如：杭州织造有限公司"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="wo-kicker">客户编号 · 必填</span>
                <input
                  className={INPUT}
                  value={customerForm.code}
                  onChange={(event) =>
                    setCustomerForm({ ...customerForm, code: event.target.value })
                  }
                  placeholder="唯一编号，例如 CUS-2026-001"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="wo-kicker">客户等级</span>
                <select
                  className={SELECT}
                  value={customerForm.tier}
                  onChange={(event) =>
                    setCustomerForm({
                      ...customerForm,
                      tier: event.target.value as CustomerForm["tier"],
                    })
                  }
                >
                  {TIERS.map((tier) => (
                    <option key={tier.value} value={tier.value}>
                      {tier.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5">
                <span className="wo-kicker">联系人（可选）</span>
                <input
                  className={INPUT}
                  value={customerForm.contactName}
                  onChange={(event) =>
                    setCustomerForm({ ...customerForm, contactName: event.target.value })
                  }
                  placeholder="例如：张三"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="wo-kicker">联系电话（可选）</span>
                <input
                  className={INPUT}
                  value={customerForm.contactPhone}
                  onChange={(event) =>
                    setCustomerForm({ ...customerForm, contactPhone: event.target.value })
                  }
                  placeholder="例如：13800000000"
                />
              </label>
              <div className="flex items-end gap-2">
                <button type="submit" className={BTN_PRIMARY} disabled={busy}>
                  保存客户
                </button>
                <button
                  type="button"
                  className={BTN_GHOST}
                  disabled={busy}
                  onClick={() => setIntake(null)}
                >
                  取消
                </button>
              </div>
            </form>
          )}

          {intake === "sample" && (
            <form
              className="mt-4 grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                submitSample();
              }}
            >
              <label className="grid gap-1.5">
                <span className="wo-kicker">样品名称 · 必填</span>
                <input
                  className={INPUT}
                  value={sampleForm.name}
                  autoFocus
                  onChange={(event) => setSampleForm({ ...sampleForm, name: event.target.value })}
                  placeholder="例如：高支棉 220g"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="wo-kicker">样品编号 · 必填</span>
                <input
                  className={INPUT}
                  value={sampleForm.code}
                  onChange={(event) => setSampleForm({ ...sampleForm, code: event.target.value })}
                  placeholder="唯一编号，例如 SMP-2026-001"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="wo-kicker">成分（可选）</span>
                <input
                  className={INPUT}
                  value={sampleForm.composition}
                  onChange={(event) =>
                    setSampleForm({ ...sampleForm, composition: event.target.value })
                  }
                  placeholder="例如：100% 棉"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="wo-kicker">克重（可选）</span>
                <input
                  className={INPUT}
                  value={sampleForm.weight}
                  onChange={(event) => setSampleForm({ ...sampleForm, weight: event.target.value })}
                  placeholder="例如：220g/m2"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="wo-kicker">计量单位</span>
                <select
                  className={SELECT}
                  value={sampleForm.unit}
                  onChange={(event) =>
                    setSampleForm({ ...sampleForm, unit: event.target.value as Unit })
                  }
                >
                  {UNITS.map((unit) => (
                    <option key={unit.value} value={unit.value}>
                      {unit.label}（{unit.value}）
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-[1fr_auto] gap-3">
                <label className="grid gap-1.5">
                  <span className="wo-kicker">成本底线（元，可选）</span>
                  <input
                    className={INPUT}
                    value={sampleForm.costFloorYuan}
                    inputMode="decimal"
                    onChange={(event) =>
                      setSampleForm({ ...sampleForm, costFloorYuan: event.target.value })
                    }
                    placeholder="例如：12.00"
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="wo-kicker">币种</span>
                  <select
                    className={SELECT}
                    value={sampleForm.currency}
                    onChange={(event) =>
                      setSampleForm({ ...sampleForm, currency: event.target.value as Currency })
                    }
                  >
                    {CURRENCIES.map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex items-end gap-2">
                <button type="submit" className={BTN_PRIMARY} disabled={busy}>
                  保存样品
                </button>
                <button
                  type="button"
                  className={BTN_GHOST}
                  disabled={busy}
                  onClick={() => setIntake(null)}
                >
                  取消
                </button>
              </div>
            </form>
          )}
        </div>

        {!seeded && (
          <p className="mt-4 text-sm text-muted">
            还没有可派发的客户 / 样品：先用上面的「＋ 客户 / ＋ 样品」内联录入，录完会自动选中。
          </p>
        )}

        {seeded && (
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
          {outcome.ok && outcome.draft && (
            <p className="mt-2 text-xs text-muted">
              草稿已进入「审批与异常分诊」窗口；批准 / 拒绝由人类决定，前端才会调内核 confirm 生效。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
