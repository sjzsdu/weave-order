import { ApprovalItem } from "@weave-order/schema";
import type {
  ApprovalItem as ApprovalItemT,
  AuditLogEntry,
  Customer,
  FabricSample,
} from "@weave-order/schema";
import { describe, expect, it, vi } from "vitest";
import { createApprovalService } from "../src/approval";
import { KernelError } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

/**
 * 审批服务离线单测：用假内核替身，验证「决策 -> 内核 confirm/reject」的分流、
 * 失败语义收敛以及只读聚合。不依赖数据库，pnpm test 离线也全绿。
 */
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "unit-approver" } };
const ID_QUOTE = "123e4567-e89b-12d3-a456-426614174000";
const ID_SHIPMENT = "123e4567-e89b-12d3-a456-426614174001";
const NOW = "2026-11-12T08:00:00.000Z";

function item(overrides: Partial<ApprovalItemT> = {}): ApprovalItemT {
  return ApprovalItem.parse({
    id: ID_QUOTE,
    kind: "quote",
    title: "报价单 · 123e4567",
    summary: "1 行 · CNY 1,000.00",
    status: "DRAFT",
    pending: true,
    amountCents: 100000,
    currency: "CNY",
    customerId: ID_QUOTE,
    createdAt: NOW,
    confirmedBy: null,
    ...overrides,
  });
}

function makeKernel(opts: { quotes?: ApprovalItemT[]; shipments?: ApprovalItemT[] } = {}) {
  const spies = {
    confirmDraft: vi.fn((_id: string, _ctx: KernelContext) =>
      Promise.resolve({ status: "SENT" as const }),
    ),
    rejectDraft: vi.fn((_id: string, _ctx: KernelContext, _note?: string) =>
      Promise.resolve({ status: "REJECTED" as const }),
    ),
    confirm: vi.fn((_id: string, _ctx: KernelContext) =>
      Promise.resolve({ status: "CONFIRMED" as const }),
    ),
    reject: vi.fn((_id: string, _ctx: KernelContext, _note?: string) =>
      Promise.resolve({ status: "CANCELLED" as const }),
    ),
  };
  const kernel = {
    quotes: {
      list: vi.fn(() => Promise.resolve(opts.quotes ?? [])),
      confirmDraft: spies.confirmDraft,
      rejectDraft: spies.rejectDraft,
    },
    shipments: {
      list: vi.fn(() => Promise.resolve(opts.shipments ?? [])),
      confirm: spies.confirm,
      reject: spies.reject,
    },
    customers: { list: vi.fn(() => Promise.resolve([] as Customer[])) },
    search: { listSamples: vi.fn(() => Promise.resolve([] as FabricSample[])) },
    audit: { list: vi.fn(() => Promise.resolve([] as AuditLogEntry[])) },
  } as unknown as Kernel;
  return { kernel, spies };
}

describe("审批服务（离线，假内核）", () => {
  it("listPending 只返回 DRAFT 且按创建时间倒序合并两类单据", async () => {
    const { kernel } = makeKernel({
      quotes: [
        item({ createdAt: "2026-11-12T07:00:00.000Z" }),
        item({ status: "SENT", pending: false, createdAt: "2026-11-12T11:00:00.000Z" }),
      ],
      shipments: [
        item({
          id: ID_SHIPMENT,
          kind: "sample_shipment",
          createdAt: "2026-11-12T09:00:00.000Z",
        }),
      ],
    });
    const queue = await createApprovalService(kernel).listPending();
    expect(queue.items).toHaveLength(2);
    expect(queue.items.map((entry) => entry.kind)).toEqual(["sample_shipment", "quote"]);
    expect(queue.items.every((entry) => entry.pending)).toBe(true);
  });

  it("批准报价 -> confirmDraft(HUMAN) -> SENT", async () => {
    const { kernel, spies } = makeKernel();
    const result = await createApprovalService(kernel).decide(
      { id: ID_QUOTE, kind: "quote", decision: "APPROVE" },
      HUMAN,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("SENT");
      expect(result.data.actorType).toBe("HUMAN");
    }
    expect(spies.confirmDraft).toHaveBeenCalledWith(ID_QUOTE, HUMAN);
    expect(spies.rejectDraft).not.toHaveBeenCalled();
  });

  it("驳回报价 -> rejectDraft(带分诊备注) -> REJECTED", async () => {
    const { kernel, spies } = makeKernel();
    const result = await createApprovalService(kernel).decide(
      { id: ID_QUOTE, kind: "quote", decision: "REJECT", note: "价格异常" },
      HUMAN,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe("REJECTED");
    expect(spies.rejectDraft).toHaveBeenCalledWith(ID_QUOTE, HUMAN, "价格异常");
  });

  it("批准寄样单 -> confirm -> CONFIRMED；驳回 -> reject -> CANCELLED", async () => {
    const { kernel, spies } = makeKernel();
    const service = createApprovalService(kernel);
    const approved = await service.decide(
      { id: ID_SHIPMENT, kind: "sample_shipment", decision: "APPROVE" },
      HUMAN,
    );
    expect(approved.ok).toBe(true);
    if (approved.ok) expect(approved.data.status).toBe("CONFIRMED");
    expect(spies.confirm).toHaveBeenCalledWith(ID_SHIPMENT, HUMAN);

    const rejected = await service.decide(
      { id: ID_SHIPMENT, kind: "sample_shipment", decision: "REJECT" },
      HUMAN,
    );
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.data.status).toBe("CANCELLED");
    expect(spies.reject).toHaveBeenCalledWith(ID_SHIPMENT, HUMAN, undefined);
  });

  it("非法决策入参 -> INVALID_INPUT，且不触达内核", async () => {
    const { kernel, spies } = makeKernel();
    const result = await createApprovalService(kernel).decide(
      { id: "not-a-uuid", kind: "quote", decision: "APPROVE" },
      HUMAN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
    expect(spies.confirmDraft).not.toHaveBeenCalled();
    expect(spies.rejectDraft).not.toHaveBeenCalled();
  });

  it("内核拒绝 -> 收敛为封闭 ToolError（不抛出、不伪造成功）", async () => {
    const { kernel, spies } = makeKernel();
    spies.confirmDraft.mockRejectedValueOnce(
      new KernelError("KERNEL_REJECTED", "只有 DRAFT 可确认", {
        reason: "INVALID_STATE_TRANSITION",
      }),
    );
    const result = await createApprovalService(kernel).decide(
      { id: ID_QUOTE, kind: "quote", decision: "APPROVE" },
      HUMAN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("KERNEL_REJECTED");
  });

  it("panorama 聚合只读快照与统计计数", async () => {
    const { kernel } = makeKernel({
      quotes: [item({ status: "SENT", pending: false })],
      shipments: [
        item({
          id: ID_SHIPMENT,
          kind: "sample_shipment",
          status: "DRAFT",
          pending: true,
          amountCents: null,
          currency: null,
        }),
      ],
    });
    const snapshot = await createApprovalService(kernel).panorama();
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.stats.quoteCount).toBe(1);
    expect(snapshot.stats.shipmentCount).toBe(1);
    expect(snapshot.stats.pendingCount).toBe(1);
    expect(snapshot.stats.sentQuoteCount).toBe(1);
  });
});
