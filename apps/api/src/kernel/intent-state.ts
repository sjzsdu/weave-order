import type { IntentStatus } from "@weave-order/schema";
import { KernelError } from "./errors";

/**
 * 意图状态机的纯逻辑：不碰数据库，单测直接打这里。
 *
 * 状态图：
 *
 *   QUEUED ──► RUNNING ──► SUCCEEDED
 *     │           ├──► FAILED
 *     │           └──► TIMEOUT（RUNNING 超过 60 秒）
 *     └──► CANCELLED（10 分钟内）
 */

/** RUNNING 超过这个时长 = 这次没整理出来，原话保留可重试。 */
export const INTENT_TIMEOUT_MS = 60_000;

/** 提交后 10 分钟内可撤销（与 product-design §8.3 #4 一致）。 */
export const INTENT_CANCEL_WINDOW_MS = 10 * 60_000;

const TRANSITIONS: Record<IntentStatus, readonly IntentStatus[]> = {
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "TIMEOUT", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  TIMEOUT: [],
};

export const INTENT_STATUS_LABEL: Record<IntentStatus, string> = {
  QUEUED: "待受理",
  RUNNING: "小织正在整理",
  SUCCEEDED: "草稿已生成",
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
  if (input.status === "TIMEOUT") {
    return "超过 60 秒还没整理出来，小织这次没完成。原话已保留，可以重试。";
  }
  if (input.status === "RUNNING") {
    return input.executorState === "NOT_CONNECTED" ? null : "小织正在整理这句话…";
  }
  return null;
}
