import { describe, expect, it } from "vitest";
import {
  CAPABILITY_ROLES,
  IntentDraft,
  IntentSource,
  IntentUnderstanding,
  Item,
  ItemListQuery,
  ItemStatus,
  OcrResult,
  QuoteShareEventType,
  ResourceField,
  ResourceStatus,
  SampleStatus,
  Source,
  canTransitionItemStatus,
  hasCapability,
  isSampleStatusAvailable,
  isTerminalItemStatus,
} from "../src";
import { NOW, UUID_A, UUID_B } from "./helpers";

/**
 * P0a 契约冻结（WAN-191）的验收测试。
 *
 * 这里只验证「契约形状 + 状态机 + 能力矩阵」，不碰内核与 HTTP：
 * 后续切片（WAN-193 起）直接依赖这些类型与断言，改坏了必须在这里红。
 */

describe("事项（Item）契约", () => {
  const base = {
    id: UUID_A,
    tenantId: UUID_B,
    status: "IN_PROGRESS" as const,
    customerId: UUID_A,
    sampleId: UUID_B,
    quantityMilli: 1500,
    unit: "meter" as const,
    currentStage: "正在核对价格",
    nextAction: "确认最终价格",
    sourceIntentId: null,
    createdBy: "membership-1",
    createdAt: NOW,
    updatedAt: NOW,
  };

  it("接受完整事项行", () => {
    expect(Item.parse(base).quantityMilli).toBe(1500);
  });

  it("拒绝浮点数量（数量与金额同一条整数纪律）", () => {
    expect(() => Item.parse({ ...base, quantityMilli: 1.5 })).toThrow();
  });

  it("未知字段一律拒绝", () => {
    expect(() => Item.parse({ ...base, ledgerBalance: 1 })).toThrow();
  });

  it("终态不可再迁移，等待态只能回到进行中或关闭", () => {
    for (const from of ItemStatus.options) {
      for (const to of ItemStatus.options) {
        const allowed = canTransitionItemStatus(from, to);
        if (from === "IN_PROGRESS") {
          expect(allowed).toBe(to !== "IN_PROGRESS");
        } else if (from === "WAITING_INPUT" || from === "WAITING_DECISION") {
          expect(allowed).toBe(to === "IN_PROGRESS" || to === "CLOSED");
        } else {
          expect(allowed).toBe(false);
        }
      }
    }
    expect(ItemStatus.options.filter(isTerminalItemStatus)).toEqual(["COMPLETED", "CLOSED"]);
  });

  it("列表查询只接受声明过的过滤器", () => {
    expect(ItemListQuery.parse({ filter: "recent", limit: 20 }).limit).toBe(20);
    expect(() => ItemListQuery.parse({ filter: "done" })).toThrow();
  });
});

describe("资源 / 原件 / OCR 契约", () => {
  it("资源状态取值与文档 §3.2 一致", () => {
    expect(ResourceStatus.options).toEqual(["DRAFT", "AVAILABLE", "ARCHIVED"]);
  });

  it("样品保留 ACTIVE 作为 AVAILABLE 的历史别名", () => {
    expect(SampleStatus.options).toEqual(["ACTIVE", "AVAILABLE", "DRAFT", "ARCHIVED"]);
    expect(isSampleStatusAvailable("ACTIVE")).toBe(true);
    expect(isSampleStatusAvailable("AVAILABLE")).toBe(true);
    expect(isSampleStatusAvailable("DRAFT")).toBe(false);
    expect(isSampleStatusAvailable("ARCHIVED")).toBe(false);
  });

  it("TEXT 原件必须有原文，图片/PDF 必须有 objectKey", () => {
    const base = {
      id: UUID_A,
      tenantId: UUID_B,
      kind: "IMAGE" as const,
      objectKey: "tenant/t/ocr/a.jpg",
      textContent: null,
      mimeType: "image/jpeg",
      byteSize: 1024,
      createdAt: NOW,
    };
    expect(Source.parse(base).objectKey).toBe("tenant/t/ocr/a.jpg");
    expect(() => Source.parse({ ...base, kind: "TEXT" })).toThrow();
    expect(() => Source.parse({ ...base, objectKey: null })).toThrow();
    expect(
      Source.parse({ ...base, kind: "TEXT", objectKey: null, textContent: "名片原文" }).textContent,
    ).toBe("名片原文");
  });

  it("字段出处行必须带 status 与 sourceKind（manual 也要显式声明）", () => {
    const field = {
      id: UUID_A,
      tenantId: UUID_B,
      resourceType: "customer" as const,
      resourceId: UUID_B,
      fieldName: "name",
      value: "杭州青织",
      status: "PENDING" as const,
      sourceId: null,
      sourceKind: "manual" as const,
      updatedBy: null,
      updatedAt: NOW,
    };
    expect(ResourceField.parse(field).sourceKind).toBe("manual");
    expect(() => ResourceField.parse({ ...field, status: "UNKNOWN" })).toThrow();
    expect(() => ResourceField.parse({ ...field, sourceKind: undefined })).toThrow();
  });

  it("OCR 失败必须带机器可读的 failureCode", () => {
    const row = {
      id: UUID_A,
      tenantId: UUID_B,
      sourceId: UUID_B,
      engine: "multimodal:test@1",
      raw: { text: "..." },
      fields: { name: "杭州青织" },
      status: "FAILED" as const,
      failureCode: "LOW_CONFIDENCE" as const,
      attempts: 2,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(OcrResult.parse(row).attempts).toBe(2);
    expect(() => OcrResult.parse({ ...row, failureCode: "随便写的原因" })).toThrow();
  });
});

describe("意图泛化（统一输入）契约", () => {
  it("入口枚举补齐移动端拍照与上传", () => {
    expect(IntentSource.options).toEqual([
      "today",
      "command-bar",
      "customer-360",
      "mobile-camera",
      "upload",
    ]);
  });

  it("结果可区分报价 / 建样 / 建档，但不接受 unknown", () => {
    for (const kind of ["quote", "sample", "customer"] as const) {
      expect(IntentDraft.parse({ kind, id: UUID_A, title: "草稿" }).kind).toBe(kind);
    }
    expect(() => IntentDraft.parse({ kind: "unknown", id: UUID_A, title: "草稿" })).toThrow();
  });

  it("理解卡把槽位与待确认问题分开", () => {
    const card = IntentUnderstanding.parse({
      kind: "quote",
      summary: "给杭州青织报 1000 米涤纶",
      slots: { customerName: "杭州青织", quantityMilli: 1000000 },
      pendingQuestions: ["用哪个样品报价？"],
    });
    expect(card.pendingQuestions).toHaveLength(1);
    expect(() => IntentUnderstanding.parse({ ...card, pendingQuestions: undefined })).toThrow();
  });
});

describe("新增能力与角色默认值", () => {
  it("客户链接的「接受意向」事件已在枚举里（D7）", () => {
    expect(QuoteShareEventType.options).toContain("ACCEPTED");
  });
  it("quote.confirm 是老板 / 主管，销售需显式授权", () => {
    expect(CAPABILITY_ROLES["quote.confirm"]).toEqual(["OWNER", "MANAGER"]);
  });

  it("resource.merge 默认只给老板（不可逆动作）", () => {
    expect(CAPABILITY_ROLES["resource.merge"]).toEqual(["OWNER"]);
  });

  it("print.execute 全员可用（打印低风险）", () => {
    expect(CAPABILITY_ROLES["print.execute"]).toHaveLength(7);
    for (const role of [
      "OWNER",
      "MANAGER",
      "SALES",
      "MERCHANDISER",
      "SAMPLE_ADMIN",
      "FINANCE",
      "VIEWER",
    ] as const) {
      expect(hasCapability(role, "print.execute")).toBe(true);
    }
  });
});
