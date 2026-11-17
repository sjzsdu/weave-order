import { describe, expect, it } from "vitest";
import { bps, currentMonthRange, date, day, money, percent, statusClass, wan } from "./format";

describe("平台控制台格式化", () => {
  it("金额按整数分渲染", () => {
    expect(money(49900)).toBe("¥499.00");
    expect(money(0)).toBe("¥0.00");
    expect(money(-1234)).toBe("-¥12.34");
  });

  it("万单位用于 MRR/ARR", () => {
    expect(wan(12_345_600)).toBe("¥12.3 万");
  });

  it("百分比与基点", () => {
    expect(percent(0.206)).toBe("20.6%");
    expect(bps(600)).toBe("6.00%");
  });

  it("状态样式按语义分档", () => {
    expect(statusClass("ACTIVE")).toBe("badge badge-ok");
    expect(statusClass("TRIAL")).toBe("badge badge-warn");
    expect(statusClass("SUSPENDED")).toBe("badge badge-danger");
  });

  it("时间统一按北京时间展示，不受进程时区影响", () => {
    expect(date("2026-11-17T05:03:30.956Z")).toBe("2026/11/17 13:03");
    // UTC 16:00 之后已进入北京时间次日
    expect(date("2026-11-17T16:30:00.000Z")).toBe("2026/11/18 00:30");
  });

  it("凌晨时间保持 24 小时制，不出现上午/下午前缀", () => {
    expect(date("2026-11-17T17:03:30.956Z")).toBe("2026/11/18 01:03");
  });

  it("日期按北京时间跨天，不出现前一天", () => {
    expect(day("2026-11-17T15:59:00.000Z")).toBe("2026/11/17");
    expect(day("2026-11-17T16:30:00.000Z")).toBe("2026/11/18");
  });

  it("空值与非法时间返回占位符", () => {
    expect(date(null)).toBe("—");
    expect(day(undefined)).toBe("—");
    expect(date("not-a-date")).toBe("—");
  });

  it("账单周期默认值按北京时间的当月计算", () => {
    // UTC 10-31 18:00 = 北京时间 11-01 02:00，应归入 11 月
    expect(currentMonthRange(new Date("2026-10-31T18:00:00.000Z"))).toEqual({
      start: "2026-11-01",
      end: "2026-11-30",
    });
    expect(currentMonthRange(new Date("2026-02-10T00:00:00.000Z"))).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
    });
  });
});
