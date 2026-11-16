import type { AuditLogEntry } from "@weave-order/schema";
import { describe, expect, it } from "vitest";
import {
  businessActionSummary,
  projectPanoramaEvents,
  startOfBusinessDay,
} from "../src/approval/panorama-events";

const TENANT = "123e4567-e89b-12d3-a456-426614174000";
const ENTITY = "123e4567-e89b-12d3-a456-426614174001";
const VIEWER = "casdoor-user-haibao";

let seq = 0;

function entry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  seq += 1;
  return {
    id: `123e4567-e89b-12d3-a456-42661417${String(1000 + seq)}`,
    tenantId: TENANT,
    seq,
    actorType: "AGENT",
    actorId: "quote-agent",
    action: "QUOTE_DRAFT_GENERATED",
    entityType: "quote",
    entityId: ENTITY,
    before: null,
    after: null,
    correlationId: null,
    createdAt: "2026-11-16T08:00:00.000Z",
    ...overrides,
  };
}

describe("动态流事件投影", () => {
  it("系统初始化事件被滤除，不冒充智能体产出", () => {
    const events = projectPanoramaEvents([
      entry({ actorType: "SYSTEM", action: "TENANT_CREATED", entityType: "tenant" }),
      entry({ actorType: "SYSTEM", action: "LLM_SETTINGS_UPDATED", entityType: "tenant" }),
      entry({ actorType: "HUMAN", action: "MEMBERSHIP_INVITED", entityType: "membership" }),
    ]);
    expect(events).toHaveLength(0);
  });

  it("人 / 智能体正确分型，智能体署名由后端给定", () => {
    const [quoteEvent, shipmentEvent, orderEvent] = projectPanoramaEvents([
      entry({ action: "QUOTE_DRAFT_GENERATED", actorId: "quoting-agent" }),
      entry({ action: "SAMPLE_SHIPMENT_CONFIRMED", actorId: "sample-followup-agent" }),
      entry({ action: "ORDER_CREATED", actorId: "inbound-intake-agent" }),
    ]);
    expect(quoteEvent?.eventKind).toBe("AGENT_DONE");
    expect(quoteEvent?.actorLabel).toBe("小织");
    expect(shipmentEvent?.actorLabel).toBe("小跟");
    expect(orderEvent?.actorLabel).toBe("小跟");
  });

  it("认不出身份时按动作归属兜底，不落到错误的人头上", () => {
    const [shipment, quote, order] = projectPanoramaEvents([
      entry({ action: "SAMPLE_SHIPMENT_DRAFTED", actorId: "brand-new-agent" }),
      entry({ action: "REVISION_REQUESTED", actorId: "brand-new-agent" }),
      entry({ action: "CUSTOMER_CREATED", actorId: "brand-new-agent" }),
    ]);
    expect(shipment?.actorLabel).toBe("小跟");
    expect(quote?.actorLabel).toBe("小织");
    expect(order?.actorLabel).toBe("小序");
  });

  it("自己做的事写「你」，别人的事写「同事」，绝不输出 UUID", () => {
    const [mine, others] = projectPanoramaEvents(
      [
        entry({ actorType: "HUMAN", actorId: VIEWER, action: "CUSTOMER_CREATED" }),
        entry({ actorType: "HUMAN", actorId: "another-subject", action: "SAMPLE_CREATED" }),
      ],
      { viewerActorId: VIEWER },
    );
    expect(mine?.eventKind).toBe("HUMAN_DONE");
    expect(mine?.actorLabel).toBe("你");
    expect(others?.actorLabel).toBe("同事");
    expect(others?.actorLabel).not.toContain("another-subject");
  });

  it("成交 / 回款升为里程碑，仍保留真实署名", () => {
    const events = projectPanoramaEvents(
      [
        entry({ action: "ORDER_CONFIRMED", actorType: "HUMAN", actorId: VIEWER }),
        entry({ action: "RECEIVABLE_PAYMENT_RECORDED", actorId: "quoting-agent" }),
      ],
      { viewerActorId: VIEWER },
    );
    expect(events.map((event) => event.eventKind)).toEqual(["MILESTONE", "MILESTONE"]);
    expect(events[0]?.actorLabel).toBe("你");
    expect(events[1]?.actorLabel).toBe("小织");
  });

  it("每条事件都带中文短句，不泄露动作枚举", () => {
    const events = projectPanoramaEvents([entry({ action: "SAMPLE_ARCHIVED" })]);
    expect(events[0]?.summary).toBe("归档了样品");
    expect(events[0]?.summary).not.toMatch(/^[A-Z_]+$/);
    // 白名单外动作（例如导入重置）根本不会成为事件。
    expect(businessActionSummary("SAMPLE_ARCHIVED")).toBe("归档了样品");
  });

  it("最多返回 limit 条，保持账本顺序", () => {
    const entries = Array.from({ length: 80 }, (_, index) =>
      entry({ createdAt: new Date(Date.UTC(2026, 10, 16, 0, index)).toISOString() }),
    );
    const events = projectPanoramaEvents(entries, { limit: 5 });
    expect(events).toHaveLength(5);
    expect(events[0]?.createdAt).toBe(entries[0]?.createdAt);
  });
});

describe("业务日边界", () => {
  it("东八区 00:00 之前仍算前一天", () => {
    // UTC 2026-11-15 15:59 = 东八区 11-15 23:59
    expect(startOfBusinessDay(new Date("2026-11-15T15:59:00.000Z")).toISOString()).toBe(
      "2026-11-14T16:00:00.000Z",
    );
    // UTC 2026-11-15 16:00 = 东八区 11-16 00:00
    expect(startOfBusinessDay(new Date("2026-11-15T16:00:00.000Z")).toISOString()).toBe(
      "2026-11-15T16:00:00.000Z",
    );
  });
});
