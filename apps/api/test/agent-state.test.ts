import { describe, expect, it } from "vitest";
import { advance, allowedTransitions, assertTransition } from "../src/agent/state";

describe("寄样跟进状态机：只允许合法跳转", () => {
  it("允许正常旅程的每一步", () => {
    expect(() => assertTransition("NEW", "SHIPMENT_DRAFTED")).not.toThrow();
    expect(() => assertTransition("SHIPMENT_DRAFTED", "TRACKED")).not.toThrow();
    expect(() => assertTransition("TRACKED", "FOLLOWUP_SUGGESTED")).not.toThrow();
    expect(() => assertTransition("FOLLOWUP_SUGGESTED", "WAITING_REPLY")).not.toThrow();
    expect(() => assertTransition("WAITING_REPLY", "REPLY_RECEIVED")).not.toThrow();
    expect(() => assertTransition("REPLY_RECEIVED", "QUOTE_DRAFTED")).not.toThrow();
    expect(() => assertTransition("QUOTE_DRAFTED", "DONE")).not.toThrow();
    expect(advance("REPLY_RECEIVED", "DONE")).toBe("DONE");
  });

  it("拒绝跳过物流/回复直接报价", () => {
    expect(() => assertTransition("NEW", "QUOTE_DRAFTED")).toThrow(/非法状态跳转/);
    expect(() => assertTransition("TRACKED", "REPLY_RECEIVED")).toThrow(/非法状态跳转/);
    expect(() => assertTransition("WAITING_REPLY", "QUOTE_DRAFTED")).toThrow(/非法状态跳转/);
  });

  it("拒绝倒流与终态再出发", () => {
    expect(() => assertTransition("TRACKED", "NEW")).toThrow(/非法状态跳转/);
    expect(() => assertTransition("DONE", "QUOTE_DRAFTED")).toThrow(/非法状态跳转/);
    expect(() => assertTransition("FAILED", "DONE")).toThrow(/非法状态跳转/);
    expect(allowedTransitions("DONE")).toEqual([]);
    expect(allowedTransitions("FAILED")).toEqual([]);
  });

  it("任何进行中的阶段都允许失败出口", () => {
    for (const stage of [
      "NEW",
      "SHIPMENT_DRAFTED",
      "TRACKED",
      "FOLLOWUP_SUGGESTED",
      "WAITING_REPLY",
      "REPLY_RECEIVED",
      "QUOTE_DRAFTED",
    ] as const) {
      expect(() => assertTransition(stage, "FAILED")).not.toThrow();
    }
  });
});
