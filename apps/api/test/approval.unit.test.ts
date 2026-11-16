import { ApprovalItem } from "@weave-order/schema";
import type {
  ApprovalItem as ApprovalItemT,
  AuditLogEntry,
  Customer,
  FabricSample,
} from "@weave-order/schema";
import { describe, expect, it, vi } from "vitest";
import { businessDayStart, createApprovalService } from "../src/approval";
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

interface ListQuery {
  pendingOnly?: boolean;
  id?: string;
  after?: { createdAt: string; id: string } | null;
}

/** 复刻内核的过滤 + keyset 分页语义，让单测能真正走翻页路径。 */
function pageOf(items: ApprovalItemT[], limit: number, query: ListQuery = {}): ApprovalItemT[] {
  let rows = items;
  if (query.id) rows = rows.filter((entry) => entry.id === query.id);
  if (query.pendingOnly) rows = rows.filter((entry) => entry.pending);
  const after = query.after;
  if (after) {
    rows = rows.filter(
      (entry) =>
        entry.createdAt < after.createdAt ||
        (entry.createdAt === after.createdAt && entry.id < after.id),
    );
  }
  return [...rows]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

function makeKernel(
  opts: {
    quotes?: ApprovalItemT[];
    shipments?: ApprovalItemT[];
    events?: AuditLogEntry[];
    todayAgentDoneCount?: number;
  } = {},
) {
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
  const quotes = opts.quotes ?? [];
  const shipments = opts.shipments ?? [];
  const kernel = {
    quotes: {
      list: vi.fn((limit: number, _ctx?: KernelContext, query?: ListQuery) =>
        Promise.resolve(pageOf(quotes, limit, query)),
      ),
      confirmDraft: spies.confirmDraft,
      rejectDraft: spies.rejectDraft,
    },
    shipments: {
      list: vi.fn((limit: number, _ctx?: KernelContext, query?: ListQuery) =>
        Promise.resolve(pageOf(shipments, limit, query)),
      ),
      confirm: spies.confirm,
      reject: spies.reject,
    },
    customers: { list: vi.fn(() => Promise.resolve([] as Customer[])) },
    search: { listSamples: vi.fn(() => Promise.resolve([] as FabricSample[])) },
    audit: {
      list: vi.fn(() => Promise.resolve([] as AuditLogEntry[])),
      businessEvents: vi.fn(() => Promise.resolve(opts.events ?? [])),
      countAgentBusinessActionsSince: vi.fn(() => Promise.resolve(opts.todayAgentDoneCount ?? 0)),
    },
  } as unknown as Kernel;
  return { kernel, spies };
}

function auditEntry(
  overrides: Partial<AuditLogEntry> & Pick<AuditLogEntry, "actorType" | "action">,
): AuditLogEntry {
  return {
    id: ID_QUOTE,
    tenantId: ID_QUOTE,
    seq: 1,
    actorType: overrides.actorType,
    actorId: "someone",
    actorRole: null,
    action: overrides.action,
    entityType: "quote",
    entityId: ID_QUOTE,
    before: null,
    after: null,
    correlationId: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe("审批服务（离线，假内核）", () => {
  it("业务日按北京时间切分：UTC 容器不会把昨晚算进今天", () => {
    // 北京时间 2026-11-16 00:30 = UTC 2026-11-15 16:30
    expect(businessDayStart(new Date("2026-11-15T16:30:00.000Z")).toISOString()).toBe(
      "2026-11-15T16:00:00.000Z",
    );
    // 北京时间 2026-11-15 23:59:59 = UTC 15:59:59，仍属于前一天
    expect(businessDayStart(new Date("2026-11-15T15:59:59.000Z")).toISOString()).toBe(
      "2026-11-14T16:00:00.000Z",
    );
  });

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

  it("150 条待办按游标翻页全部可见（超过旧上限 100 也不漏单）", async () => {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    const quotes = Array.from({ length: 150 }, (_, index) =>
      item({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        createdAt: new Date(base + index * 1000).toISOString(),
      }),
    );
    const { kernel } = makeKernel({ quotes });
    const service = createApprovalService(kernel);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const queue = await service.listPending(undefined, { limit: 40, cursor });
      expect(queue.items.length).toBeLessThanOrEqual(40);
      seen.push(...queue.items.map((entry) => entry.id));
      if (!queue.hasMore) {
        expect(queue.nextCursor ?? null).toBeNull();
        break;
      }
      expect(queue.nextCursor).toBeTruthy();
      cursor = queue.nextCursor ?? null;
    }

    const expected = [...quotes]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((entry) => entry.id);
    expect(seen).toHaveLength(150);
    expect(new Set(seen).size).toBe(150);
    expect(seen).toEqual(expected);
  });

  it("非法游标 -> KERNEL_REJECTED/INVALID_INPUT（不静默回到第一页）", async () => {
    const { kernel } = makeKernel();
    await expect(
      createApprovalService(kernel).listPending(undefined, { cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ code: "KERNEL_REJECTED", details: { reason: "INVALID_INPUT" } });
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

  it("panorama 事件按身份给标签：智能体按动作归属、本人是「你」、同事是「同事」", async () => {
    const { kernel } = makeKernel({
      events: [
        auditEntry({ id: ID_SHIPMENT, actorType: "AGENT", action: "QUOTE_DRAFT_GENERATED" }),
        auditEntry({
          id: ID_QUOTE,
          actorType: "HUMAN",
          action: "CUSTOMER_CREATED",
          actorId: HUMAN.actor.id,
        }),
        auditEntry({
          id: "123e4567-e89b-12d3-a456-426614174099",
          actorType: "HUMAN",
          action: "CUSTOMER_CREATED",
          actorId: "another-human",
        }),
      ],
      todayAgentDoneCount: 3,
    });
    const snapshot = await createApprovalService(kernel).panorama(HUMAN);
    expect(snapshot.events.map((event) => event.actorLabel)).toEqual(["小织", "你", "同事"]);
    expect(snapshot.events[0]?.kind).toBe("AGENT_DONE");
    expect(snapshot.events[1]?.kind).toBe("HUMAN_DONE");
    // 标题数字用「今天智能体业务动作」的精确计数，不是审计条数。
    expect(snapshot.stats.todayAgentDoneCount).toBe(3);
    expect(snapshot.stats.auditCount).toBe(0);
  });
});
