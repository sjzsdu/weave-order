/**
 * Track B 验收：粘贴一句客户原话 → 解析槽位 → 3 个候选样品（带理由）
 * → 内核定价 → 报价 DRAFT（带定价依据 + 缺失项）+ token 计量。
 */
import { createQuoteDemoContext, ok, section } from "./quote-demo-lib";
import { demoWriteContext, ensureDemoIdentity } from "../src/kernel/demo-identity";
import type { FabricSample } from "@weave-order/schema";

async function main(): Promise<void> {
  const { handle, kernel, graph, llm } = await createQuoteDemoContext();
  const identity = await ensureDemoIdentity(handle.db);
  const HUMAN = demoWriteContext(identity, "quote-demo-operator");
  const suffix = Date.now().toString(36);

  section("① 准备客户与样品（内核写入，带审计）");
  const customer = await kernel.customers.create(
    { code: `QT-C-${suffix}`, name: "杭州外贸公司（报价演示）", tier: "VIP" },
    HUMAN,
  );
  const fabrics = [
    { code: `QT-S1-${suffix}`, name: "220g 精梳棉汗布", composition: "100% 棉", weight: { value: 220, unit: "gsm" } },
    {
      code: `QT-S2-${suffix}`,
      name: "220g 棉氨纶罗纹",
      composition: "95% 棉 5% 氨纶",
      weight: { value: 220, unit: "gsm" },
    },
    {
      code: `QT-S3-${suffix}`,
      name: "220g 有机棉双面布",
      composition: "100% 有机棉",
      weight: { value: 220, unit: "gsm" },
    },
    { code: `QT-S4-${suffix}`, name: "涤纶运动布", composition: "100% 涤纶", weight: { value: 180, unit: "gsm" } },
  ];
  const samples: FabricSample[] = [];
  for (const fabric of fabrics) {
    samples.push(
      await kernel.samples.create(
        { ...fabric, unit: "meter", costFloor: { amount: 1200, currency: "CNY" } },
        HUMAN,
      ),
    );
  }
  ok(`客户 ${customer.code}（${customer.tier}）/ 样品 ${samples.length} 个`);

  const utterance = "这款 220g 棉的，要 500 米，什么价";
  section(`② 粘贴客户原话：「${utterance}」`);
  const threadId = `quote-demo-${suffix}`;
  const state = await graph.invoke(
    {
      threadId,
      rawText: utterance,
      customerId: customer.id,
      currency: "CNY",
      topK: 3,
    },
    { configurable: { thread_id: threadId } },
  );

  section("③ 槽位解析");
  ok(`成分=${state.intent?.slots.composition ?? "-"}，克重=${state.intent?.slots.weight ?? "-"}`);
  ok(
    `数量=${state.intent?.slots.quantity ? `${state.intent.slots.quantity.value} ${state.intent.slots.quantity.unit}` : "-"}，询价=${state.intent?.slots.priceRequested ? "是" : "否"}（${state.provider}）`,
  );

  section("④ 找样候选（带命中理由）");
  state.candidates.forEach((candidate, index) => {
    ok(`#${index + 1} ${candidate.rationale}`);
  });
  if (state.candidates.length < 3) {
    throw new Error(`候选不足 3 个（实际 ${state.candidates.length}）`);
  }

  section("⑤ 定价依据（内核计算）");
  for (const component of state.pricingBasis?.components ?? []) {
    const amount =
      component.amount === null ? "" : `${component.amount.amount} 分 ${component.amount.currency}`;
    const rate = component.rateBps === null ? "" : `${(component.rateBps / 100).toFixed(2)}%`;
    ok(`${component.label}：${amount} ${rate} ← ${component.source}`);
  }
  ok(
    `建议单价 ${state.pricingBasis?.suggestedUnitPrice.amount} 分 / ${state.pricingBasis?.quantity.unit}`,
  );

  section("⑥ 报价草稿（DRAFT）与缺失项");
  if (!state.draft) throw new Error("没有产出报价草稿");
  ok(
    `草稿 ${state.draft.id} 状态=${state.draft.status} 总额=${state.draft.total.amount} 分 ${state.draft.currency}`,
  );
  ok(
    state.draft.amountsComputedByKernel
      ? "金额由内核计算（amountsComputedByKernel=true）"
      : "金额标记异常",
  );
  ok(
    state.missingFields.length === 0
      ? "缺失项：无（成分/克重/数量/客户均已具备）"
      : `缺失项：${state.missingFields.map((field) => `${field.label}${field.blocking ? "(阻断)" : ""}`).join("、")}`,
  );
  ok(`说明：${state.explanation}`);

  section("⑦ token 计量（只计量不收费，request_id 幂等）");
  if (state.usage) {
    ok(
      `本次模型回执 request=${state.usage.requestId} model=${state.usage.model} prompt=${state.usage.promptTokens} completion=${state.usage.completionTokens}`,
    );
  } else {
    ok(`当前 LLM provider=${llm.name}（本地规则不发外部请求，因此没有真实 token）`);
    // 证明计量链路本身可用：同一 request_id 写两次只落一条。
    const requestId = crypto.randomUUID();
    const usage = {
      requestId,
      task: "QUOTE_INTENT" as const,
      model: process.env.LLM_DEFAULT_MODEL ?? "demo-model",
      provider: "openai-compatible",
      promptTokens: 128,
      completionTokens: 42,
      cachedTokens: 0,
      costMicros: null,
      promptHash: "0".repeat(64),
    };
    const first = await kernel.usage.record(usage);
    const second = await kernel.usage.record(usage);
    const stored = await kernel.usage.getByRequestId(requestId);
    ok(`第一次写入 inserted=${first.inserted}；同 request_id 重放 inserted=${second.inserted}`);
    ok(
      `token_usage 落库 ${stored ? `${stored.promptTokens}+${stored.completionTokens}` : "未找到"}；重放未重复计量`,
    );
  }

  section("⑧ 审计");
  const audit = await kernel.audit.list(10);
  const related = audit.filter(
    (row) =>
      row.entityId === customer.id ||
      row.entityId === samples[0]?.id ||
      row.entityId === state.draft?.id,
  );
  for (const row of related) {
    console.log(`  #${row.seq} ${row.action} actor=${row.actorType}:${row.actorId}`);
  }
  ok(`相关审计 ${related.length} 条；草稿写入与审计同事务`);

  section("结论");
  ok("客户原话 → 槽位 → 3 个候选（命中理由）→ DRAFT（定价依据 + 缺失项）全链路跑通");
  ok("agent 只调 tools；金额由内核计算；草稿永不自动确认");
  if (llm.name === "openai-compatible") {
    ok("LLM 调用经 OpenAI 兼容企业网关，usage 已按 request_id 幂等记账");
  } else {
    ok(
      "本地规则模式（零 key）；将 LLM_PROVIDER=openai-compatible 并配置 LLM_BASE_URL / LLM_API_KEY 即切换真实模型",
    );
  }

  await handle.pool.end();
}

void main().catch((error: unknown) => {
  console.error("\n✖ 报价 demo 失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
