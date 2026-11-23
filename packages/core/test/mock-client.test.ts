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

  it("资源概览演示数据的分类合计与可用样品一致", async () => {
    const overview = await createMockApiClient().resourceOverview();
    const categoryTotal = overview.samples.categories.reduce((sum, row) => sum + row.count, 0);
    expect(categoryTotal).toBe(overview.samples.available);
    expect(overview.samples.completeness).toHaveLength(4);
  });
});
