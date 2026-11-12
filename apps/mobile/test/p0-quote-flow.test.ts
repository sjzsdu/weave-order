import { describe, expect, it, beforeEach } from "vitest";
import { createOfflineQueue, isVersionConflict, memoryStorage } from "@weave-order/core";
import { createMockServer } from "../src/lib/mock/server";
import { createMemoryMockStorage } from "../src/lib/mock/storage";
import { createMobileApi } from "../src/lib/mobile-api";
import type { MobileApi } from "../src/lib/mobile-api";

/**
 * P0 主链路（契约级）：
 * 原话 → 报价草稿 → 改一个价 → 批准 → 分享链接。
 * mock 服务端与真后端使用同一套 Zod 契约，因此这里同时验证前端契约客户端。
 */

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const SAMPLE_ID = "22222222-2222-4222-8222-111111111111";

function buildApi(): { api: MobileApi; server: ReturnType<typeof createMockServer> } {
  const server = createMockServer({
    storage: createMemoryMockStorage(),
    latencyMs: 0,
    now: () => new Date("2026-11-12T10:00:00.000Z"),
  });
  const api = createMobileApi("http://mock.local", server.fetch, () => null);
  return { api, server };
}

async function createDraft(api: MobileApi) {
  const search = await api.searchBySpec({ query: "棉 220g", limit: 5 });
  if (!search.ok) throw new Error(search.error.message);
  const sampleId = search.data.matches[0]?.sample.id ?? SAMPLE_ID;
  const result = await api.generateQuoteDraft({
    customerId: CUSTOMER_ID,
    items: [
      {
        fabricSampleId: sampleId,
        quantity: { value: 500, unit: "meter" },
        unitPrice: { amount: 0, currency: "CNY" },
      },
    ],
    currency: "CNY",
    validityDays: 14,
    remarks: "这款 220g 棉的，要 500 米，什么价？",
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.data.draft;
}

describe("P0 报价主链路（mock 契约）", () => {
  let api: MobileApi;
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    const built = buildApi();
    api = built.api;
    server = built.server;
  });

  it("原话 → 草稿（金额由内核算）→ 改价 → 批准 → 分享链接", async () => {
    const draft = await createDraft(api);
    expect(draft.status).toBe("DRAFT");
    expect(draft.amountsComputedByKernel).toBe(true);
    expect(draft.total.amount).toBeGreaterThan(0);

    const revision = await api.createRevision({
      entityType: "quote",
      entityId: draft.id,
      source: "INLINE",
      instruction: "移动端改价 13.90 → 15.00",
      patch: {
        items: [{ fabricSampleId: SAMPLE_ID, unitPrice: { amount: 1500, currency: "CNY" } }],
      },
      baseVersion: 1,
    });
    expect(revision.status).toBe("PENDING");

    const decided = await api.decideRevision({
      revisionRequestId: revision.id,
      decision: "APPROVE",
      note: "本人改价",
    });
    expect(decided.status).toBe("APPROVED");

    const detail = await api.getQuote(draft.id);
    expect(detail.version).toBe(2);
    expect(detail.status).toBe("DRAFT");
    expect(detail.draft.items[0]?.unitPrice.amount).toBe(1500);
    expect(detail.draft.total.amount).toBe(750_000);

    const approval = await api.decideApproval({ id: draft.id, kind: "quote", decision: "APPROVE" });
    expect(approval.ok).toBe(true);
    if (approval.ok) expect(approval.data.status).toBe("SENT");

    const share = await api.createQuoteShare({
      quoteId: draft.id,
      expiresInDays: 14,
      requirePhoneTail: true,
      allowPdf: true,
    });
    expect(share.url).toMatch(/^https:\/\/.+\/s\/.+/);
    expect(share.token.length).toBeGreaterThanOrEqual(32);
    expect(share.share.tokenHash).not.toBe(share.token);
  });

  it("草稿不能分享（批准前没有链接）", async () => {
    const draft = await createDraft(api);
    await expect(api.createQuoteShare({ quoteId: draft.id })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("服务端版本已变时改价返回 409，而不是静默覆盖", async () => {
    const draft = await createDraft(api);
    server.simulateRemoteEdit(draft.id);
    await expect(
      api.createRevision({
        entityType: "quote",
        entityId: draft.id,
        source: "INLINE",
        instruction: "并发改价",
        patch: {
          items: [{ fabricSampleId: SAMPLE_ID, unitPrice: { amount: 1400, currency: "CNY" } }],
        },
        baseVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("图片找样拒绝 base64，只接受直传后的 imageUrl", async () => {
    const response = await server.fetch("http://mock.local/api/tools/search-by-image", {
      method: "POST",
      body: JSON.stringify({ image: { mimeType: "image/jpeg", base64: "AAAA" } }),
    });
    expect(response.status).toBe(400);

    await expect(api.searchByImageUrl("mock://media/fabric.jpg")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("离线队列：冲突标记后可人工按服务端版本重试", async () => {
    const queue = createOfflineQueue(memoryStorage());
    await queue.enqueue({
      opId: "op-1",
      kind: "quote.revise",
      payload: {},
      baseVersion: 1,
    });
    const flushed = await queue.flush({
      submit: () => Promise.reject(Object.assign(new Error("版本冲突"), { status: 409 })),
      isConflict: isVersionConflict,
    });
    expect(flushed.conflicts).toBe(1);
    expect((await queue.list())[0]?.status).toBe("conflict");

    await queue.retryWithServerVersion("op-1", 3);
    expect((await queue.list())[0]).toMatchObject({
      status: "pending",
      baseVersion: 3,
      serverVersion: 3,
      attempts: 0,
    });
  });
});
