import { describe, expect, it, vi } from "vitest";
import { InboundRepliesService } from "../src/kernel/inbound-replies.service";
import type { Db } from "@weave-order/db";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
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
            returning: async () => (existing.length > 0 ? [] : [toRow(v)]),
          }),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => existing,
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
    channel: v.channel,
    externalId: v.externalId,
    customerRef: v.customerRef,
    text: v.text,
    receivedAt: v.receivedAt,
    rawPayload: v.rawPayload,
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
        text: "要 500 米，电话 13800138000，邮箱 a@b.com",
      },
      { now: () => NOW },
    );

    expect(result.text).not.toContain("13800138000");
    expect(result.text).not.toContain("a@b.com");
    expect(result.text).toContain("8000");
    expect(result.channel).toBe("manual");
    expect(captured.values?.rawPayload).toBeNull();
    expect(captured.values?.text).toBe(result.text);
  });

  it("截图录入：调用 OCR，rawPayload 记 imageUrl 引用", async () => {
    const { db, captured } = fakeDb();
    const svc = new InboundRepliesService(db, TENANT_ID);
    const ocr = vi.fn().mockResolvedValue({ text: "这款 220g 棉的多少钱？" });

    const result = await svc.ingest(
      { channel: "screenshot", externalId: "ext-2", imageUrl: "data:image/png;base64,AAAA" },
      { ocr, now: () => NOW },
    );

    expect(ocr).toHaveBeenCalledWith("data:image/png;base64,AAAA");
    expect(result.text).toBe("这款 220g 棉的多少钱？");
    expect(captured.values?.rawPayload).toEqual({ imageUrl: "data:image/png;base64,AAAA" });
  });

  it("幂等：同 (tenant, channel, externalId) 重复提交，返回既有行，不覆盖", async () => {
    const existing = [
      toRow({
        tenantId: TENANT_ID,
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
      { channel: "manual", externalId: "ext-1", text: "完全不同的新文本" },
      { now: () => NOW },
    );

    expect(result.id).toBe(ROW_ID);
    expect(result.text).toBe("已脱敏的旧文本");
  });

  it("渠道校验：截图缺 imageUrl / 文本缺 text / 截图缺 OCR 均拒绝", async () => {
    const { db } = fakeDb();
    const svc = new InboundRepliesService(db, TENANT_ID);

    await expect(svc.ingest({ channel: "screenshot", externalId: "e" })).rejects.toThrow(/imageUrl/);
    await expect(svc.ingest({ channel: "manual", externalId: "e" })).rejects.toThrow(/text/);
    await expect(
      svc.ingest({ channel: "screenshot", externalId: "e", imageUrl: "x" }),
    ).rejects.toThrow(/视觉模型/);
  });

  it("脱敏后为空则拒绝入库", async () => {
    const { db } = fakeDb();
    const svc = new InboundRepliesService(db, TENANT_ID);
    await expect(
      svc.ingest({ channel: "manual", externalId: "e", text: "   " }, { now: () => NOW }),
    ).rejects.toThrow(/为空/);
  });
});
