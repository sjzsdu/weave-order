import { describe, expect, it, vi } from "vitest";
import { ManualReplySource, createReplySource } from "../src/platform/reply-source";

const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const SHIPMENT_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";

describe("ManualReplySource（评审 D4 契约映射）", () => {
  it("把手工录入回复映射成 RawCustomerReply：channel 统一为 WECHAT", async () => {
    const fetchManualReply = vi.fn().mockResolvedValue({
      id: MESSAGE_ID,
      text: "这款报价多少钱？",
      receivedAt: "2026-11-15T00:00:00.000Z",
    });
    const source = new ManualReplySource(fetchManualReply);

    const reply = await source.fetchLatest({ customerId: CUSTOMER_ID, shipmentId: SHIPMENT_ID });

    expect(fetchManualReply).toHaveBeenCalledWith({
      customerId: CUSTOMER_ID,
      shipmentId: SHIPMENT_ID,
    });
    expect(reply).toEqual({
      id: MESSAGE_ID,
      channel: "WECHAT",
      text: "这款报价多少钱？",
      receivedAt: "2026-11-15T00:00:00.000Z",
    });
  });

  it("没有未消费回复时返回 null（图会停在 interrupt，不伪造回复）", async () => {
    const source = new ManualReplySource(() => Promise.resolve(null));
    expect(
      await source.fetchLatest({ customerId: CUSTOMER_ID, shipmentId: SHIPMENT_ID }),
    ).toBeNull();
  });

  it("超过 2000 字的长文本不再被 RawCustomerReply 拒绝", async () => {
    const longText = "长".repeat(6000);
    const source = new ManualReplySource(() =>
      Promise.resolve({
        id: MESSAGE_ID,
        text: longText,
        receivedAt: "2026-11-15T00:00:00.000Z",
      }),
    );
    const reply = await source.fetchLatest({ customerId: CUSTOMER_ID, shipmentId: SHIPMENT_ID });
    expect(reply?.text).toHaveLength(6000);
  });

  it("createReplySource('manual') 必须绑定取数实现", () => {
    expect(() => createReplySource("manual")).toThrow(/fetchManualReply/);
    expect(
      createReplySource("manual", { fetchManualReply: () => Promise.resolve(null) }).name,
    ).toBe("manual-v1");
  });
});
