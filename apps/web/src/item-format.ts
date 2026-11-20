import type { ItemStatus } from "@weave-order/schema";

/** 事项状态的中文文案与色调：列表、详情、筛选用同一份，避免两处叫法不一致。 */
export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  IN_PROGRESS: "处理中",
  WAITING_INPUT: "等待补充",
  WAITING_DECISION: "等待决定",
  COMPLETED: "已完成",
  CLOSED: "已关闭",
};

export const ITEM_STATUS_TONE: Record<
  ItemStatus,
  "success" | "warning" | "danger" | "info" | "neutral"
> = {
  IN_PROGRESS: "info",
  WAITING_INPUT: "warning",
  WAITING_DECISION: "warning",
  COMPLETED: "success",
  CLOSED: "neutral",
};

export const ITEM_UNIT_LABEL: Record<string, string> = {
  meter: "米",
  kilogram: "千克",
  yard: "码",
  piece: "件",
};

/** 数量以千分之一单位存整数（1.5 米 = 1500），展示时统一还原。 */
export function itemQuantityText(quantityMilli: number | null, unit: string): string {
  if (quantityMilli === null) return "数量待补充";
  const value = quantityMilli / 1000;
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 3 })} ${
    ITEM_UNIT_LABEL[unit] ?? unit
  }`;
}
