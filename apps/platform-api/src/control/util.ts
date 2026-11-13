import type { JsonValue } from "@weave-order/schema";

export function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** 审计快照：只允许可 JSON 序列化的值，避免把驱动对象写进 JSONB。 */
export function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

export function currentMonthPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function monthStart(now = new Date()): string {
  return `${currentMonthPeriod(now)}-01`;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}
