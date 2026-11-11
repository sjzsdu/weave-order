import { describe, expect, it } from "vitest";
import {
  AuditLogEntry,
  ConfirmQuoteInput,
  CreateCustomerInput,
  CreateSampleShipmentInput,
  T005CreateSampleShipmentResult,
} from "../src";

const UUID_A = "123e4567-e89b-12d3-a456-426614174000";
const UUID_B = "123e4567-e89b-12d3-a456-426614174001";
const NOW = "2026-11-11T11:00:00.000Z";

describe("内核输入契约（strict：未知字段一律拒绝）", () => {
  it("CreateCustomerInput 接受合法输入并填充默认 tier", () => {
    const parsed = CreateCustomerInput.safeParse({ code: "C001", name: "杭州织造" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.tier).toBe("REGULAR");
  });

  it("CreateCustomerInput 拒绝夹带未知账本字段", () => {
    const parsed = CreateCustomerInput.safeParse({
      code: "C001",
      name: "杭州织造",
      version: 99,
    });
    expect(parsed.success).toBe(false);
  });

  it("CreateSampleShipmentInput 拒绝 status 字段（智能体不能指定 CONFIRMED）", () => {
    const parsed = CreateSampleShipmentInput.safeParse({
      customerId: UUID_A,
      status: "CONFIRMED",
      items: [{ sampleId: UUID_B, quantity: { value: 3, unit: "meter" } }],
    });
    expect(parsed.success).toBe(false);
  });

  it("ConfirmQuoteInput 只接受 UUID", () => {
    expect(ConfirmQuoteInput.safeParse({ quoteId: "not-a-uuid" }).success).toBe(false);
    expect(ConfirmQuoteInput.safeParse({ quoteId: UUID_A }).success).toBe(true);
  });
});

describe("T-005 create_sample_shipment 输出契约", () => {
  it("接受 DRAFT 寄样单 + 内核计算的跟进时间", () => {
    const ok = T005CreateSampleShipmentResult.safeParse({
      ok: true,
      data: {
        shipment: {
          id: UUID_A,
          customerId: UUID_B,
          status: "DRAFT",
          channel: "COURIER",
          carrier: null,
          trackingNumber: null,
          note: null,
          items: [{ sampleId: UUID_B, quantity: { value: 3, unit: "meter" } }],
          confirmedBy: null,
          confirmedAt: null,
          createdAt: NOW,
        },
        followupSuggestedAt: NOW,
      },
    });
    expect(ok.success).toBe(true);
  });
});

describe("审计日志读取契约", () => {
  it("接受合法审计记录", () => {
    const parsed = AuditLogEntry.safeParse({
      id: UUID_A,
      seq: 1,
      actorType: "AGENT",
      actorId: "agent-1",
      action: "QUOTE_DRAFT_GENERATED",
      entityType: "quote",
      entityId: UUID_B,
      before: null,
      after: { totalAmount: 180750 },
      correlationId: null,
      createdAt: NOW,
    });
    expect(parsed.success).toBe(true);
  });

  it("拒绝未知审计动作（动作集合封闭）", () => {
    const parsed = AuditLogEntry.safeParse({
      id: UUID_A,
      seq: 1,
      actorType: "AGENT",
      actorId: "agent-1",
      action: "SOMETHING_ELSE",
      entityType: "quote",
      entityId: UUID_B,
      before: null,
      after: null,
      correlationId: null,
      createdAt: NOW,
    });
    expect(parsed.success).toBe(false);
  });
});
