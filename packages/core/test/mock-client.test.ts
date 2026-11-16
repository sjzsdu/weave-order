import { describe, expect, it } from "vitest";
import { createMockApiClient } from "../src/mock-client";

describe("mock transport（无后端预览）", () => {
  it("审批详情带出处、diff 与草稿态", async () => {
    const client = createMockApiClient();
    const queue = await client.approvals();
    expect(queue.items).toHaveLength(1);

    const detail = await client.approvalDetail(queue.items[0]!.id, "quote");
    expect(detail.draft.state).toBe("DRAFT");
    expect(detail.provenance.length).toBeGreaterThan(0);
    expect(detail.diffs[0]?.after).toBe(1520);
    expect(detail.missingFields[0]?.label).toBe("交期");
  });

  it("批准返回 HUMAN 回执，队列清空", async () => {
    const client = createMockApiClient();
    const [item] = (await client.approvals()).items;
    const result = await client.decideApproval({
      id: item!.id,
      kind: item!.kind,
      decision: "APPROVE",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.actorType).toBe("HUMAN");
      expect(result.data.status).toBe("SENT");
    }
    expect((await client.approvals()).items).toHaveLength(0);
  });

  it("意图通道回真实三态之一，并明确标注演示数据", async () => {
    const client = createMockApiClient();
    const result = await client.runQuoteAgent({ rawText: "这款 220g 棉的，要 500 米，什么价" });
    expect(result.status).toBe("DRAFTED");
    expect(result.draft).not.toBeNull();
    expect(result.explanation).toContain("演示模式");
  });
});
