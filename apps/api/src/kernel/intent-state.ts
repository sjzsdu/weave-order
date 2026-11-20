import type { IntentStatus } from "@weave-order/schema";
import { KernelError } from "./errors";

/**
 * 意图状态机的纯逻辑：不碰数据库，单测直接打这里。
 *
 * 状态图：
 *
 *   QUEUED ──► RUNNING ──► SUCCEEDED
 *     │           ├──► FAILED
 *     │           ├──► NEEDS_INPUT（报价 agent 缺客户/数量等阻断项）
 *     │           └──► TIMEOUT（RUNNING 超过 60 秒）
 *     └──► CANCELLED（10 分钟内）
 */

/** RUNNING 超过这个时长 = 这次没整理出来，原话保留可重试。 */
export const INTENT_TIMEOUT_MS = 60_000;

/** 提交后 10 分钟内可撤销（与 product-design §8.3 #4 一致）。 */
export const INTENT_CANCEL_WINDOW_MS = 10 * 60_000;

const TRANSITIONS: Record<IntentStatus, readonly IntentStatus[]> = {
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "NEEDS_INPUT", "FAILED", "TIMEOUT", "CANCELLED"],
  SUCCEEDED: [],
  NEEDS_INPUT: [],
  FAILED: [],
  CANCELLED: [],
  TIMEOUT: [],
};

export const INTENT_STATUS_LABEL: Record<IntentStatus, string> = {
  QUEUED: "待受理",
  RUNNING: "小织正在整理",
  SUCCEEDED: "草稿已生成",
  NEEDS_INPUT: "还差一点信息",
  FAILED: "没整理出来",
  CANCELLED: "已撤销",
  TIMEOUT: "超时未完成",
};

export function isTerminalIntentStatus(status: IntentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function canTransitionIntent(from: IntentStatus, to: IntentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * 统一输入可以「从等待点继续」：理解卡纠正后重新整理、或确认后开始执行。
 *
 * 与 `TRANSITIONS` 分开，是为了不把「SUCCEEDED 可被重新开启」扩散到旧报价意图：
 * 旧路径仍然一经成功就是终态，只有 `/inbound/:id/{start,revise}` 使用这张表。
 */
const RESUMABLE: readonly IntentStatus[] = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "NEEDS_INPUT",
  "FAILED",
  "TIMEOUT",
];

export function canRestartIntent(from: IntentStatus): boolean {
  return RESUMABLE.includes(from);
}

export function assertIntentTransition(from: IntentStatus, to: IntentStatus): void {
  if (!canTransitionIntent(from, to)) {
    throw new KernelError("KERNEL_REJECTED", `意图不能从 ${from} 变成 ${to}`, {
      reason: "INTENT_INVALID_TRANSITION",
      resourceType: "intent",
    });
  }
}

/** 撤销窗口按「提交时间」算，不按最后更新时间：拖延不会延长窗口。 */
export function intentCancelDeadline(createdAt: Date): Date {
  return new Date(createdAt.getTime() + INTENT_CANCEL_WINDOW_MS);
}

export function isIntentCancellable(
  status: IntentStatus,
  createdAt: Date,
  now: Date = new Date(),
): boolean {
  if (isTerminalIntentStatus(status)) return false;
  return now.getTime() < intentCancelDeadline(createdAt).getTime();
}

/** RUNNING 卡住超过 60 秒即判定超时；其余状态不参与超时。 */
export function isIntentTimedOut(
  status: IntentStatus,
  since: Date,
  now: Date = new Date(),
): boolean {
  if (status !== "RUNNING") return false;
  return now.getTime() - since.getTime() > INTENT_TIMEOUT_MS;
}

/**
 * 给人看的状态说明。`NOT_CONNECTED` 时必须明说「尚未接入」，
 * 这是「消灭假成功」的文案出口 —— 任何调用方都不得把它改写成成功。
 */
export function intentNotice(input: {
  status: IntentStatus;
  executorState: "NOT_CONNECTED" | "CONNECTED";
  failureReason: string | null;
}): string | null {
  if (input.status === "QUEUED" && input.executorState === "NOT_CONNECTED") {
    return "小织的整理服务还没接入。这句话已经记录下来了，但暂时不会被自动处理，也不会出现在审批里。";
  }
  if (input.status === "FAILED") {
    return input.failureReason ?? "小织这次没整理出来，原话还在，可以重试。";
  }
  // 「缺信息」不是失败：原话保留，补上缺失项就能重来。
  if (input.status === "NEEDS_INPUT") {
    return input.failureReason ?? "还差一些信息才能出报价草稿，补齐后重试即可。";
  }
  if (input.status === "TIMEOUT") {
    return "超过 60 秒还没整理出来，小织这次没完成。原话已保留，可以重试。";
  }
  if (input.status === "RUNNING") {
    return input.executorState === "NOT_CONNECTED" ? null : "小织正在整理这句话…";
  }
  return null;
}
