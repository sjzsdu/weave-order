import { describe, expect, it } from "vitest";
import {
  ITEM_STATUS_TRANSITIONS,
  ItemStatus,
  canTransitionItemStatus,
  isTerminalItemStatus,
} from "@weave-order/schema";

/**
 * 事项状态机的全量矩阵测试（WAN-193 验收 4）。
 *
 * 逐对枚举 5×5 个迁移，断言唯一事实源 `ITEM_STATUS_TRANSITIONS` 的
 * 允许/拒绝与 `canTransitionItemStatus` 完全一致；任何一个方向被误改都会红。
 */
describe("事项状态机", () => {
  const statuses = ItemStatus.options;

  for (const from of statuses) {
    for (const to of statuses) {
      const allowed = ITEM_STATUS_TRANSITIONS[from].includes(to);
      it(`${from} → ${to} ${allowed ? "允许" : "拒绝"}`, () => {
        expect(canTransitionItemStatus(from, to)).toBe(allowed);
      });
    }
  }

  it("终态不再接受任何迁移", () => {
    for (const terminal of ["COMPLETED", "CLOSED"] as const) {
      expect(isTerminalItemStatus(terminal)).toBe(true);
      expect(ITEM_STATUS_TRANSITIONS[terminal]).toEqual([]);
    }
    for (const status of ["IN_PROGRESS", "WAITING_INPUT", "WAITING_DECISION"] as const) {
      expect(isTerminalItemStatus(status)).toBe(false);
    }
  });

  it("两种等待态不能互相直连", () => {
    expect(canTransitionItemStatus("WAITING_INPUT", "WAITING_DECISION")).toBe(false);
    expect(canTransitionItemStatus("WAITING_DECISION", "WAITING_INPUT")).toBe(false);
  });
});
