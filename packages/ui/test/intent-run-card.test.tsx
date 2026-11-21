import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IntentView } from "@weave-order/schema";
import { IntentRunCard } from "../src/intent-run-card";

const intent = IntentView.parse({
  id: "123e4567-e89b-12d3-a456-426614174000",
  tenantId: "123e4567-e89b-12d3-a456-426614174001",
  text: "给天宝纺织报个价：金棉 230g，500 米",
  source: "upload",
  status: "SUCCEEDED",
  statusLabel: "理解卡已就绪，待确认",
  executorState: "CONNECTED",
  notice: "先确认理解卡，或逐字段纠正后再执行。",
  failureReason: null,
  draft: null,
  attachments: [],
  understanding: {
    kind: "quote",
    summary: "给天宝纺织报价 500 米金棉",
    slots: { quantity: 500, unit: "meter" },
    pendingQuestions: [],
    fields: [],
    tasks: [],
  },
  cancellableUntil: null,
  createdAt: "2026-11-21T09:00:00.000Z",
  updatedAt: "2026-11-21T09:00:01.000Z",
  startedAt: "2026-11-21T09:00:00.000Z",
  finishedAt: "2026-11-21T09:00:01.000Z",
  cancelledAt: null,
});

describe("意图运行卡", () => {
  it("理解完成但未执行时可以回到原理解卡继续确认", () => {
    const html = renderToStaticMarkup(<IntentRunCard intent={intent} />);

    expect(html).toContain("继续确认");
    expect(html).toContain(`/inbound?intent=${intent.id}`);
  });
});
