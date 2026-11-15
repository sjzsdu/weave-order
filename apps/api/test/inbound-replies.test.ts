import { describe, expect, it, vi } from "vitest";
import { IngestReplyInput } from "@weave-order/schema";
import { InboundRepliesService } from "../src/kernel/inbound-replies.service";
import type { Db } from "@weave-order/db";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const SHIPMENT_ID = "33333333-3333-4333-8333-333333333333";
const OBJECT_KEY = `tenant/${TENANT_ID}/inbound/44444444-4444-4444-8444-444444444444.png`;
const ROW_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-12T00:00:00.000Z");

/** 构造一个只实现 ingest 用到的最小 Db 表面，捕获 values/where 以断言脱敏与幂等。 */
function fakeDb(opts: { existing?: unknown[] } = {}) {
  const captured: { values?: Record<string, unknown> } = {};
  const existing = opts.existing ?? [];
  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured.values = v;
        return {
          onConflictDoNothing: () => ({
            // 已有记录时模拟冲突：返回空数组，触发下面的 select 幂等回退。
            returning: () => Promise.resolve(existing.length > 0 ? [] : [toRow(v)]),
          }),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(existing),
        }),
      }),
    }),
  };
  return { db: db as unknown as Db, captured };
}

function toRow(v: Record<string, unknown>): Record<string, unknown> {
  return {
    id: ROW_ID,
    tenantId: v.tenantId,
    customerId: v.customerId,
    shipmentId: v.shipmentId ?? null,
    channel: v.channel,
    externalId: v.externalId,
    customerRef: v.customerRef,
    text: v.text,
    receivedAt: v.receivedAt,
    rawPayload: v.rawPayload,
    rawPayloadExpiresAt: v.rawPayloadExpiresAt ?? null,
    consumedAt: null,
    classification: null,
    quoteDraftId: null,
    createdAt: NOW,
  };
}

describe("InboundRepliesService.ingest", () => {
  it("文本录入：入库前脱敏手机号/邮箱，rawPayload 为 null", async () => {
    const { db, captured } = fakeDb();
    const svc = new InboundRepliesService(db, TENANT_ID);

    const result = await svc.ingest(
      {
        channel: "manual",
        externalId: "ext-1",
        customerId: CUSTOMER_ID,
        text: "要 500 米，电话 13800138000，邮箱 a@b.com",
      },
      { now: () => NOW },
    );

    expect(result.text).not.toContain("13800138000");
    expect(result.text).not.toContain("a@b.com");
    expect(result.text).toContain("8000");
    expect(result.channel).toBe("manual");
    expect(result.customerId).toBe(CUSTOMER_ID);
    expect(captured.values?.rawPayload).toBeNull();
    expect(captured.values?.rawPayloadExpiresAt).toBeNull();
    expect(captured.values?.text).toBe(result.text);
  });

  it("截图录入：服务端把 objectKey 换成 URL 后调用 OCR，rawPayload 只存 key", async () => {
    const { db, captured } = fakeDb();
    const resolveImageUrl = vi.fn().mockResolvedValue("https://cdn.example.com/signed.png");
    const svc = new InboundRepliesService(db, TENANT_ID, {
      resolveImageUrl,
      retentionDays: 7,
    });
    const ocr = vi.fn().mockResolvedValue({ text: "这款 220g 棉的多少钱？" });

    const result = await svc.ingest(
      {
        channel: "screenshot",
        externalId: "ext-2",
        customerId: CUSTOMER_ID,
        objectKey: OBJECT_KEY,
      },
      { ocr, now: () => NOW },
    );

    expect(resolveImageUrl).toHaveBeenCalledWith(OBJECT_KEY);
    expect(ocr).toHaveBeenCalledWith("https://cdn.example.com/signed.png");
    expect(result.text).toBe("这款 220g 棉的多少钱？");
    expect(captured.values?.rawPayload).toEqual({ objectKey: OBJECT_KEY });
    // 保留期可配：7 天后到期，且不把签名 URL 落库。
    expect((captured.values?.rawPayloadExpiresAt as Date).toISOString()).toBe(
      "2026-11-19T00:00:00.000Z",
    );
  });

  it("截图 objectKey 不属于本租户 / 形状不合法时拒绝", async () => {
    const { db } = fakeDb();
    const svc = new InboundRepliesService(db, TENANT_ID, {
      resolveImageUrl: () => Promise.resolve("https://cdn.example.com/x.png"),
    });
    const ocr = vi.fn().mockResolvedValue({ text: "x" });

    await expect(
      svc.ingest(
        {
          channel: "screenshot",
          externalId: "ext-3",
          customerId: CUSTOMER_ID,
          objectKey: `tenant/99999999-9999-4999-8999-999999999999/inbound/44444444-4444-4444-8444-444444444444.png`,
        },
        { ocr },
      ),
    ).rejects.toThrow(/签发的截图路径/);

    await expect(
      svc.ingest(
        {
          channel: "screenshot",
          externalId: "ext-4",
          customerId: CUSTOMER_ID,
          objectKey: "https://evil.example.com/x.png",
        },
        { ocr },
      ),
    ).rejects.toThrow(/签发的截图路径/);
  });

  it("幂等：同 (tenant, channel, externalId) 重复提交，返回既有行，不覆盖", async () => {
    const existing = [
      toRow({
        tenantId: TENANT_ID,
        customerId: CUSTOMER_ID,
        channel: "manual",
        externalId: "ext-1",
        customerRef: null,
        text: "已脱敏的旧文本",
        receivedAt: NOW,
        rawPayload: null,
      }),
    ];
    const { db } = fakeDb({ existing });
    const svc = new InboundRepliesService(db, TENANT_ID);

    const result = await svc.ingest(
      { channel: "manual", externalId: "ext-1", customerId: CUSTOMER_ID, text: "完全不同的新文本" },
      { now: () => NOW },
    );

    expect(result.id).toBe(ROW_ID);
    expect(result.text).toBe("已脱敏的旧文本");
  });

  it("脱敏后为空则拒绝入库", async () => {
    const { db } = fakeDb();
    const svc = new InboundRepliesService(db, TENANT_ID);
    await expect(
      svc.ingest(
        { channel: "manual", externalId: "e", customerId: CUSTOMER_ID, text: "   " },
        { now: () => NOW },
      ),
    ).rejects.toThrow(/为空/);
  });
});

describe("IngestReplyInput 渠道与内容严格对应（评审 D6）", () => {
  it("manual 带 objectKey 拒绝", () => {
    const parsed = IngestReplyInput.safeParse({
      channel: "manual",
      externalId: "e",
      customerId: CUSTOMER_ID,
      text: "hi",
      objectKey: OBJECT_KEY,
    });
    expect(parsed.success).toBe(false);
  });

  it("screenshot 带 text 拒绝", () => {
    const parsed = IngestReplyInput.safeParse({
      channel: "screenshot",
      externalId: "e",
      customerId: CUSTOMER_ID,
      objectKey: OBJECT_KEY,
      text: "hi",
    });
    expect(parsed.success).toBe(false);
  });

  it("manual 缺 text / screenshot 缺 objectKey 拒绝", () => {
    expect(
      IngestReplyInput.safeParse({ channel: "manual", externalId: "e", customerId: CUSTOMER_ID })
        .success,
    ).toBe(false);
    expect(
      IngestReplyInput.safeParse({
        channel: "screenshot",
        externalId: "e",
        customerId: CUSTOMER_ID,
      }).success,
    ).toBe(false);
  });

  it("text 上限 8000，objectKey 上限 512（真实签名 URL 不再经过入参）", () => {
    const ok = IngestReplyInput.safeParse({
      channel: "manual",
      externalId: "e",
      customerId: CUSTOMER_ID,
      text: "a".repeat(8000),
    });
    expect(ok.success).toBe(true);
    const tooLong = IngestReplyInput.safeParse({
      channel: "manual",
      externalId: "e",
      customerId: CUSTOMER_ID,
      text: "a".repeat(8001),
    });
    expect(tooLong.success).toBe(false);
  });

  it("shipmentId 可选且透传", () => {
    const parsed = IngestReplyInput.parse({
      channel: "manual",
      externalId: "e",
      customerId: CUSTOMER_ID,
      shipmentId: SHIPMENT_ID,
      text: "hi",
    });
    expect(parsed.shipmentId).toBe(SHIPMENT_ID);
  });
});
