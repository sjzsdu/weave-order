import { describe, expect, it } from "vitest";
import {
  CustomerImportRow,
  ImportBatch,
  ImportBatchResult,
  ImportRowError,
  ImportRowReceipt,
  MAX_IMPORT_ROWS,
  SampleImportRow,
} from "../src";

const validCustomer = { code: "C-001", name: "杭州织造" };
const validSample = {
  code: "S-001",
  name: "高支棉",
  unit: "meter" as const,
  costFloor: { amount: 1200, currency: "CNY" as const },
};

describe("导入契约（第六步）", () => {
  it("CustomerImportRow 复用内核 Create 输入：tier 默认 REGULAR、strict 拒未知字段", () => {
    const parsed = CustomerImportRow.safeParse(validCustomer);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.tier).toBe("REGULAR");
    expect(CustomerImportRow.safeParse({ ...validCustomer, version: 3 }).success).toBe(false);
  });

  it("CustomerImportRow 可选私有上下文按领域契约校验", () => {
    const ok = CustomerImportRow.safeParse({
      ...validCustomer,
      context: {
        preferenceNotes: ["偏好高支棉"],
        pricingBehavior: {
          sensitivity: "HIGH",
          counterofferAcceptanceRate: null,
          typicalAcceptanceWindowDays: null,
        },
      },
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.context?.pricingBehavior?.notes).toEqual([]);

    // 非法上下文（越界概率）必须被拒，不能静默落库。
    expect(
      CustomerImportRow.safeParse({
        ...validCustomer,
        context: { pricingBehavior: { sensitivity: "HIGH", counterofferAcceptanceRate: 2 } },
      }).success,
    ).toBe(false);
    // 系统管理字段不接受导入。
    expect(
      CustomerImportRow.safeParse({ ...validCustomer, context: { decisionDeltas: [] } }).success,
    ).toBe(false);
  });

  it("SampleImportRow 金额整数分、单位枚举、strict", () => {
    expect(SampleImportRow.safeParse(validSample).success).toBe(true);
    expect(
      SampleImportRow.safeParse({ ...validSample, costFloor: { amount: 1.5, currency: "CNY" } })
        .success,
    ).toBe(false);
    expect(SampleImportRow.safeParse({ ...validSample, unit: "meter2" }).success).toBe(false);
    expect(SampleImportRow.safeParse({ ...validSample, status: "CONFIRMED" }).success).toBe(false);
  });

  it("ImportBatch 信封：行是 unknown（非 any）、有上限、strict", () => {
    expect(
      ImportBatch.safeParse({ customers: [validCustomer], samples: [validSample] }).success,
    ).toBe(true);
    const empty = ImportBatch.safeParse({});
    expect(empty.success).toBe(true);
    if (empty.success) {
      expect(empty.data.customers).toEqual([]);
      expect(empty.data.samples).toEqual([]);
    }
    expect(ImportBatch.safeParse({ extra: 1 }).success).toBe(false);
    expect(
      ImportBatch.safeParse({ customers: Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => 1) })
        .success,
    ).toBe(false);
  });

  it("ImportRowError 失败码封闭可判别（未知 code 被拒）", () => {
    expect(
      ImportRowError.safeParse({ code: "INVALID_INPUT", message: "坏行", issues: [] }).success,
    ).toBe(true);
    expect(
      ImportRowError.safeParse({
        code: "DUPLICATE_IN_BATCH",
        message: "重复",
        conflictsWithRow: 0,
      }).success,
    ).toBe(true);
    expect(ImportRowError.safeParse({ code: "MADE_UP", message: "?" }).success).toBe(false);
  });

  it("ImportRowReceipt 成功/失败可判别", () => {
    expect(
      ImportRowReceipt.safeParse({ ok: true, kind: "customer", row: 0, key: "C-001" }).success,
    ).toBe(true);
    expect(
      ImportRowReceipt.safeParse({
        ok: false,
        kind: "fabric_sample",
        row: 1,
        key: "S-002",
        error: { code: "WRITE_FAILED", message: "回滚" },
      }).success,
    ).toBe(true);
    expect(
      ImportRowReceipt.safeParse({ ok: false, kind: "customer", row: 0, key: "C-1" }).success,
    ).toBe(false);
  });

  it("ImportBatchResult：committed=false 时导入计数必须为 0（单事务回滚口径）", () => {
    const rejected = ImportBatchResult.safeParse({
      committed: false,
      batchError: { code: "BATCH_REJECTED", message: "有坏行", rejectedRows: 1 },
      totalRows: 2,
      okRows: 1,
      rejectedRows: 1,
      importedCustomers: 0,
      importedSamples: 0,
      correlationId: null,
      rows: [
        { ok: true, kind: "customer", row: 0, key: "C-001" },
        {
          ok: false,
          kind: "fabric_sample",
          row: 0,
          key: "S-001",
          error: { code: "INVALID_INPUT", message: "坏行", issues: [] },
        },
      ],
    });
    expect(rejected.success).toBe(true);

    const committed = ImportBatchResult.safeParse({
      committed: true,
      batchError: null,
      totalRows: 1,
      okRows: 1,
      rejectedRows: 0,
      importedCustomers: 1,
      importedSamples: 0,
      correlationId: "123e4567-e89b-12d3-a456-426614174000",
      rows: [{ ok: true, kind: "customer", row: 0, key: "C-001" }],
    });
    expect(committed.success).toBe(true);
  });
});
