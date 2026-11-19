import { describe, expect, it } from "vitest";
import type { QuoteDraft, SpecMatch } from "@weave-order/schema";
import {
  entryParamsFromRoute,
  INITIAL_QUOTE_STATE,
  missingForDraft,
  primaryAction,
  QUOTE_CLICK_EVENTS,
  searchQuery,
  transition,
} from "../src/domain/quote/quote-flow";
import type { QuoteEvent, QuoteFlowState } from "../src/domain/quote/quote-flow";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

function run(events: QuoteEvent[], from: QuoteFlowState = INITIAL_QUOTE_STATE): QuoteFlowState {
  return events.reduce(transition, from);
}

const match: SpecMatch = {
  sample: {
    id: "22222222-2222-4222-8222-111111111111",
    tenantId: "33333333-3333-4333-8333-111111111111",
    code: "S-001",
    name: "40S 精梳棉",
    unit: "meter",
    primaryImageUrl: null,
    composition: "棉",
    weight: "220g",
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  score: 0.93,
  matchedOn: ["composition", "weight"],
} as unknown as SpecMatch;

const draft = {
  id: "44444444-4444-4444-8444-111111111111",
  tenantId: "33333333-3333-4333-8333-111111111111",
  customerId: CUSTOMER_ID,
  status: "DRAFT",
  version: 1,
  currency: "CNY",
  items: [
    {
      fabricSampleId: match.sample.id,
      description: "40S 精梳棉",
      quantity: { value: 500, unit: "meter" },
      unitPrice: { amount: 1500, currency: "CNY" },
      lineTotal: { amount: 750_000, currency: "CNY" },
    },
  ],
  subtotal: { amount: 750_000, currency: "CNY" },
  total: { amount: 750_000, currency: "CNY" },
  amountsComputedByKernel: true,
  validityDays: 14,
  expiresAt: "2026-12-01T00:00:00.000Z",
  createdAt: "2026-11-19T00:00:00.000Z",
  remarks: null,
} as unknown as QuoteDraft;

describe("报价闭环协调器", () => {
  it("粘入口不预填客户；只有从客户入口进才预填", () => {
    const pasted = run([{ type: "enter", params: { mode: "paste", customerId: CUSTOMER_ID } }]);
    expect(pasted.customerId).toBeNull();
    expect(pasted.phase).toBe("input");

    const fromCustomer = run([
      { type: "enter", params: { mode: "customer", customerId: CUSTOMER_ID } },
    ]);
    expect(fromCustomer.customerId).toBe(CUSTOMER_ID);

    const fromSample = run([
      {
        type: "enter",
        params: { mode: "sample", sampleId: match.sample.id, customerId: CUSTOMER_ID },
      },
    ]);
    expect(fromSample.customerId).toBeNull();
    expect(fromSample.sampleId).toBe(match.sample.id);
  });

  it("草稿必须绑定客户：未选客户时拦住并给出可读原因", () => {
    const state = run([
      { type: "enter", params: { mode: "paste" } },
      { type: "parseStarted" },
      { type: "parseSucceeded", matches: [match] },
    ]);
    expect(state.phase).toBe("candidates");
    expect(missingForDraft(state)).toMatch(/先选客户/);

    const selected = run([{ type: "customerSelected", customerId: CUSTOMER_ID }], state);
    expect(missingForDraft(selected)).toBeNull();
  });

  it("解析结果写入可改槽位，数量与单位跟随原话", () => {
    const state = run([
      { type: "enter", params: { mode: "paste" } },
      { type: "parseStarted" },
      {
        type: "parseSucceeded",
        matches: [match],
        composition: "涤棉",
        weight: "180g",
        deliveryHint: "本周五",
        quantity: { value: 300, unit: "yard" },
      },
    ]);
    expect(state.phase).toBe("candidates");
    expect(state.composition).toBe("涤棉");
    expect(state.weight).toBe("180g");
    expect(state.quantity).toBe("300");
    expect(state.unit).toBe("yard");
    expect(searchQuery(state)).toBe("涤棉 180g");
  });

  it("空结果区分「确实没有」，文案不混用", () => {
    const none = run([
      { type: "enter", params: { mode: "paste" } },
      { type: "parseStarted" },
      { type: "parseSucceeded", matches: [] },
    ]);
    expect(none.emptyReason).toBe("NONE");

    const indexing = run([{ type: "parseSucceeded", matches: [], emptyReason: "INDEXING" }], {
      ...none,
      phase: "parsing",
    });
    expect(indexing.emptyReason).toBe("INDEXING");
  });

  it("候选页改成分只更新槽位，不清掉候选", () => {
    const state = run([
      { type: "enter", params: { mode: "paste" } },
      { type: "parseStarted" },
      { type: "parseSucceeded", matches: [match] },
      { type: "parseSucceeded", matches: [], composition: "亚麻" },
    ]);
    expect(state.phase).toBe("candidates");
    expect(state.composition).toBe("亚麻");
    expect(state.matches).toHaveLength(1);
  });

  it("批准前必须是草稿态；候选页重复点击不会跳步", () => {
    const fromCandidates = run([
      { type: "enter", params: { mode: "paste" } },
      { type: "parseStarted" },
      { type: "parseSucceeded", matches: [match] },
      { type: "approveStarted" },
    ]);
    expect(fromCandidates.phase).toBe("candidates");

    const fromDraft = run(
      [
        { type: "customerSelected", customerId: CUSTOMER_ID },
        { type: "draftCreated", draft, unitPrice: "15.00" },
        { type: "approveStarted" },
      ],
      fromCandidates,
    );
    expect(fromDraft.phase).toBe("approving");

    const doubleTap = transition(fromDraft, { type: "approveStarted" });
    expect(doubleTap.phase).toBe("approving");
  });

  it("主按钮按能力切换：可批「批准并分享」，不可批「提交审批」", () => {
    const draftState = run([{ type: "draftCreated", draft, unitPrice: "15.00" }], {
      ...INITIAL_QUOTE_STATE,
      customerId: CUSTOMER_ID,
      phase: "draft",
    });
    expect(primaryAction(draftState, { canApprove: true })).toMatchObject({
      kind: "approve",
      label: "批准并分享",
    });
    expect(primaryAction(draftState, { canApprove: false })).toMatchObject({
      kind: "submit",
      label: "提交审批",
    });
  });

  it("批准后原地分享：approved → sharing，按钮变成复制链接", () => {
    const approved = run([{ type: "approveStarted" }, { type: "approved" }], {
      ...INITIAL_QUOTE_STATE,
      phase: "draft",
      customerId: CUSTOMER_ID,
      draft,
    });
    expect(approved.phase).toBe("approved");
    expect(primaryAction(approved, { canApprove: true }).kind).toBe("none");

    const shared = run(
      [{ type: "shareReady", url: "https://app.weaveorder.cn/s/token" }],
      approved,
    );
    expect(shared.phase).toBe("sharing");
    expect(primaryAction(shared, { canApprove: true })).toMatchObject({
      kind: "share",
      label: "复制链接",
    });
  });

  it("离线批准回到草稿并明确「联网后提交」，不假装已批准", () => {
    const queued = run([{ type: "approvalQueued", note: "联网后提交" }], {
      ...INITIAL_QUOTE_STATE,
      phase: "approving",
      customerId: CUSTOMER_ID,
      draft,
    });
    expect(queued.phase).toBe("draft");
    expect(queued.status).toBe("DRAFT");
    expect(queued.offlineQueued).toBe(true);
    expect(queued.offlineNote).toMatch(/联网后/);
  });

  it("全链路点击 ≤5 次（含必须选客户的一次）", () => {
    const events: QuoteEvent[] = [
      { type: "enter", params: { mode: "paste" } },
      { type: "rawChanged", raw: "青禾要 300 米 涤棉 180g" },
      { type: "customerSelected", customerId: CUSTOMER_ID },
      { type: "parseStarted" },
      { type: "parseSucceeded", matches: [match] },
      { type: "draftCreated", draft, unitPrice: "15.00" },
      { type: "approveStarted" },
      { type: "approved" },
      { type: "shareReady", url: "https://app.weaveorder.cn/s/token" },
    ];
    const clicks = events.filter((event) => QUOTE_CLICK_EVENTS.has(event.type)).length;
    expect(clicks).toBeLessThanOrEqual(5);
    const final = run(events);
    expect(final.phase).toBe("sharing");
    expect(final.shareUrl).toContain("/s/");
  });

  it("从客户页进入不需要再选客户：全链路 4 次点击", () => {
    const events: QuoteEvent[] = [
      { type: "enter", params: { mode: "customer", customerId: CUSTOMER_ID } },
      { type: "parseStarted" },
      { type: "parseSucceeded", matches: [match] },
      { type: "draftCreated", draft, unitPrice: "15.00" },
      { type: "approveStarted" },
    ];
    expect(events.filter((event) => QUOTE_CLICK_EVENTS.has(event.type))).toHaveLength(4);
    expect(run(events).phase).toBe("approving");
  });

  it("退一步：草稿 → 候选 → 输入", () => {
    const atCandidates = run([
      { type: "parseSucceeded", matches: [match] },
      { type: "draftCreated", draft, unitPrice: "15.00" },
    ]);
    const backToCandidates = transition(atCandidates, { type: "back" });
    expect(backToCandidates.phase).toBe("candidates");
    expect(transition(backToCandidates, { type: "back" }).phase).toBe("input");
  });
});

describe("入口参数", () => {
  it("老链接只带 sampleId / customerId 时补出 mode，不断链", () => {
    expect(entryParamsFromRoute({ sampleId: "s1" })).toMatchObject({
      mode: "sample",
      sampleId: "s1",
    });
    expect(entryParamsFromRoute({ customerId: CUSTOMER_ID })).toMatchObject({
      mode: "customer",
      customerId: CUSTOMER_ID,
    });
    expect(entryParamsFromRoute({ quoteId: "q1" })).toMatchObject({ mode: "edit", quoteId: "q1" });
    expect(entryParamsFromRoute({ mode: "voice" })).toMatchObject({ mode: "paste" });
    expect(entryParamsFromRoute({})).toMatchObject({ mode: "paste" });
  });
});
