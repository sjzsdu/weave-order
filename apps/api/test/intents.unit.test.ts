import { describe, expect, it } from "vitest";
import { SubmitIntentInput } from "@weave-order/schema";
import {
  assertIntentTransition,
  canTransitionIntent,
  canRestartIntent,
  intentCancelDeadline,
  intentNotice,
  isIntentCancellable,
  isIntentTimedOut,
  isTerminalIntentStatus,
  INTENT_CANCEL_WINDOW_MS,
  INTENT_TIMEOUT_MS,
} from "../src/kernel/intent-state";

/**
 * 意图状态机（纯函数层，不碰数据库）。
 *
 * 这组断言守的是「消灭假成功」的三条底线：
 * 1. 状态只能按图走，不存在从 QUEUED 直接到 SUCCEEDED 的跳级。
 * 2. 执行器未接入时文案必须说「还没接入」，不得出现成功暗示。
 * 3. 撤销窗口与超时阈值是硬常量，任何改动都必须同时改测试。
 */

const NOW = new Date("2026-11-16T12:00:00.000Z");

describe("状态机", () => {
  it("只允许 QUEUED → RUNNING / CANCELLED", () => {
    expect(canTransitionIntent("QUEUED", "RUNNING")).toBe(true);
    expect(canTransitionIntent("QUEUED", "CANCELLED")).toBe(true);
    expect(canTransitionIntent("QUEUED", "SUCCEEDED")).toBe(false);
    expect(canTransitionIntent("QUEUED", "FAILED")).toBe(false);
    expect(canTransitionIntent("QUEUED", "TIMEOUT")).toBe(false);
  });

  it("RUNNING 可以走向成功 / 失败 / 超时 / 撤销", () => {
    for (const to of ["SUCCEEDED", "NEEDS_INPUT", "FAILED", "TIMEOUT", "CANCELLED"] as const) {
      expect(canTransitionIntent("RUNNING", to)).toBe(true);
    }
    expect(canTransitionIntent("RUNNING", "QUEUED")).toBe(false);
  });

  it("终态不再变化", () => {
    for (const status of ["SUCCEEDED", "NEEDS_INPUT", "FAILED", "CANCELLED", "TIMEOUT"] as const) {
      expect(isTerminalIntentStatus(status)).toBe(true);
      expect(canTransitionIntent(status, "RUNNING")).toBe(false);
      expect(canTransitionIntent(status, "CANCELLED")).toBe(false);
    }
    expect(isTerminalIntentStatus("QUEUED")).toBe(false);
    expect(isTerminalIntentStatus("RUNNING")).toBe(false);
  });

  it("非法跳级抛内核错误且带可判别原因", () => {
    expect(() => assertIntentTransition("QUEUED", "SUCCEEDED")).toThrow(/不能从 QUEUED/);
  });

  it("统一输入可以从等待点继续（不改旧路径的终态语义）", () => {
    for (const status of ["SUCCEEDED", "NEEDS_INPUT", "FAILED", "TIMEOUT"] as const) {
      expect(canRestartIntent(status)).toBe(true);
      // 旧报价路径仍然认为这些状态是终态，只有 /inbound 的 resume 会重新开启。
      expect(isTerminalIntentStatus(status)).toBe(true);
    }
    expect(canRestartIntent("CANCELLED")).toBe(false);
  });
});

describe("撤销窗口", () => {
  it("10 分钟内可撤销，窗口按提交时间算", () => {
    const createdAt = new Date(NOW.getTime() - 9 * 60_000);
    expect(isIntentCancellable("QUEUED", createdAt, NOW)).toBe(true);
    expect(intentCancelDeadline(createdAt).getTime() - createdAt.getTime()).toBe(
      INTENT_CANCEL_WINDOW_MS,
    );
  });

  it("超过 10 分钟不可撤销，终态也不可撤销", () => {
    const old = new Date(NOW.getTime() - 11 * 60_000);
    expect(isIntentCancellable("QUEUED", old, NOW)).toBe(false);
    expect(isIntentCancellable("RUNNING", old, NOW)).toBe(false);
    expect(isIntentCancellable("SUCCEEDED", NOW, NOW)).toBe(false);
    expect(isIntentCancellable("CANCELLED", NOW, NOW)).toBe(false);
  });
});

describe("超时判定", () => {
  it("只有 RUNNING 超过 60 秒算超时", () => {
    const started = new Date(NOW.getTime() - INTENT_TIMEOUT_MS - 1);
    expect(isIntentTimedOut("RUNNING", started, NOW)).toBe(true);
    expect(isIntentTimedOut("RUNNING", new Date(NOW.getTime() - 1_000), NOW)).toBe(false);
    expect(isIntentTimedOut("QUEUED", started, NOW)).toBe(false);
    expect(isIntentTimedOut("SUCCEEDED", started, NOW)).toBe(false);
  });
});

describe("状态文案", () => {
  it("执行器未接入必须明说「还没接入」，且不出现成功暗示", () => {
    const notice = intentNotice({
      status: "QUEUED",
      executorState: "NOT_CONNECTED",
      failureReason: null,
    });
    expect(notice).toContain("还没接入");
    expect(notice).not.toMatch(/成功|已生成|完成/);
  });

  it("失败与超时都给出原因与可重试的说明", () => {
    expect(
      intentNotice({ status: "FAILED", executorState: "CONNECTED", failureReason: "客户没认出来" }),
    ).toBe("客户没认出来");
    expect(
      intentNotice({ status: "TIMEOUT", executorState: "CONNECTED", failureReason: null }),
    ).toContain("超过 60 秒");
  });

  it("缺信息不是失败：保留具体缺失项并提示可重试", () => {
    const notice = intentNotice({
      status: "NEEDS_INPUT",
      executorState: "CONNECTED",
      failureReason: "还差：客户（请选择这条询价属于哪个客户）。原话已保留，补齐后重试即可。",
    });
    expect(notice).toContain("还差：客户");
    expect(notice).toContain("原话已保留");
  });

  it("成功态不再附加说明（草稿卡片本身承载后续动作）", () => {
    expect(
      intentNotice({ status: "SUCCEEDED", executorState: "CONNECTED", failureReason: null }),
    ).toBeNull();
  });
});

describe("提交契约", () => {
  const valid = {
    text: "这款 220g 棉的，要 500 米，什么价",
    source: "today" as const,
    clientRequestId: "8f8f6f0e-intent-1",
  };

  it("接受合法输入并 trim 文本", () => {
    const parsed = SubmitIntentInput.parse({ ...valid, text: "  报价  " });
    expect(parsed.text).toBe("报价");
  });

  it("拒绝空文本与过短幂等键", () => {
    expect(() => SubmitIntentInput.parse({ ...valid, text: "   " })).toThrow();
    expect(() => SubmitIntentInput.parse({ ...valid, clientRequestId: "short" })).toThrow();
  });

  it("拒绝未知入口与多余字段（不静默丢弃）", () => {
    expect(() => SubmitIntentInput.parse({ ...valid, source: "email" })).toThrow();
    expect(() => SubmitIntentInput.parse({ ...valid, tenantId: "x" })).toThrow();
  });
});
