import { describe, expect, it } from "vitest";
import {
  cameraEntrySchema,
  parseCameraMode,
  parseQuoteEntryQuery,
  quoteEntrySchema,
  resolveQuoteEntry,
} from "../src/lib/entry-params";

describe("报价入口参数", () => {
  it("默认入口是粘贴原话", () => {
    expect(parseQuoteEntryQuery({})).toEqual({ mode: "paste" });
    expect(resolveQuoteEntry(null)).toEqual({ mode: "paste" });
  });

  it("paste 允许带样品或客户", () => {
    expect(quoteEntrySchema.safeParse({ mode: "paste", sampleId: "s-1" }).success).toBe(true);
    expect(quoteEntrySchema.safeParse({ mode: "paste", customerId: "c-1" }).success).toBe(true);
  });

  it("带目标的入口必须给 id", () => {
    expect(quoteEntrySchema.safeParse({ mode: "sample" }).success).toBe(false);
    expect(quoteEntrySchema.safeParse({ mode: "sample", sampleId: "s-1" }).success).toBe(true);
    expect(quoteEntrySchema.safeParse({ mode: "customer" }).success).toBe(false);
    expect(quoteEntrySchema.safeParse({ mode: "customer", customerId: "c-1" }).success).toBe(true);
    expect(quoteEntrySchema.safeParse({ mode: "edit" }).success).toBe(false);
    expect(quoteEntrySchema.safeParse({ mode: "edit", quoteId: "q-1" }).success).toBe(true);
  });

  it("改价入口不接受把 customerId 当 quoteId 混用", () => {
    const parsed = quoteEntrySchema.safeParse({ mode: "edit", customerId: "c-1" });
    expect(parsed.success).toBe(false);
  });

  it("非法 mode 退回默认入口，而不是把半截参数带进页面", () => {
    expect(parseQuoteEntryQuery({ mode: "voice" })).toEqual({ mode: "paste" });
    expect(parseQuoteEntryQuery({ mode: "sample" })).toEqual({ mode: "paste" });
  });

  it("深链 query 能还原出完整入口", () => {
    expect(parseQuoteEntryQuery({ mode: "edit", quoteId: "q-9" })).toEqual({
      mode: "edit",
      quoteId: "q-9",
    });
  });

  it("本地暂存优先于 query；暂存是脏数据时退回 query", () => {
    expect(
      resolveQuoteEntry({ mode: "paste", customerId: "c-2" }, { mode: "edit", quoteId: "q-1" }),
    ).toEqual({ mode: "paste", customerId: "c-2" });
    expect(resolveQuoteEntry({ mode: "nope" }, { mode: "edit", quoteId: "q-1" })).toEqual({
      mode: "edit",
      quoteId: "q-1",
    });
  });
});

describe("相机入口参数", () => {
  it("六种模式都能过校验", () => {
    for (const mode of ["find", "waybill", "sample", "signature", "cargo", "receipt"] as const) {
      expect(cameraEntrySchema.safeParse({ mode }).success).toBe(true);
    }
  });

  it("未知模式被拒绝", () => {
    expect(cameraEntrySchema.safeParse({ mode: "scan" }).success).toBe(false);
    expect(parseCameraMode("scan")).toBeNull();
    expect(parseCameraMode(null)).toBeNull();
    expect(parseCameraMode("find")).toBe("find");
  });
});
