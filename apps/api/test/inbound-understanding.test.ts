import { describe, expect, it } from "vitest";
import {
  buildUnderstanding,
  classifyInboundKind,
  extractQuantitySlot,
  inboundReadiness,
  reviseUnderstanding,
} from "../src/kernel/inbound-understanding";
import type { InboundSourceInsight } from "../src/kernel/inbound-understanding";

const CARD: InboundSourceInsight = {
  sourceId: "11111111-1111-4111-8111-111111111111",
  kind: "bizcard",
  ocrStatus: "SUCCEEDED",
  fields: {
    company: "杭州青禾服饰有限公司",
    contact: "张三",
    title: "经理",
    phone: "13800138000",
    tel: "",
    address: "杭州市余杭区",
    business: "",
    email: "zhang@example.com",
  },
  ocrText: "杭州青禾服饰有限公司 张三 经理 13800138000",
  failureCode: null,
};

const LABEL: InboundSourceInsight = {
  sourceId: "22222222-2222-4222-8222-222222222222",
  kind: "label",
  ocrStatus: "SUCCEEDED",
  fields: {
    product: "32S 精梳棉",
    composition: "100% 棉",
    gsm: "220",
    width: "150",
    lot: "A-2026",
    supplier: "绍兴某纺织",
  },
  ocrText: "100% 棉 220g 150cm",
  failureCode: null,
};

describe("意图分派", () => {
  it("名片 + 建档措辞 → 建客户", () => {
    expect(classifyInboundKind({ text: "拍张名片建档", sources: [CARD] })).toBe("customer");
  });

  it("标签 + 建样措辞 → 建样品", () => {
    expect(classifyInboundKind({ text: "这张标签建个样品", sources: [LABEL] })).toBe("sample");
  });

  it("报价措辞优先于附件提示", () => {
    expect(classifyInboundKind({ text: "给青禾报这款 500 米的价格", sources: [CARD, LABEL] })).toBe(
      "quote",
    );
  });

  it("明确纠正的 kind 覆盖文本判断", () => {
    expect(
      classifyInboundKind({ text: "拍张名片建档", sources: [CARD], kindOverride: "sample" }),
    ).toBe("sample");
  });
});

describe("数量槽位", () => {
  it("从中文原话抓数量和单位", () => {
    expect(extractQuantitySlot("这款要 500 米，报个价")).toEqual({ value: 500, unit: "meter" });
    expect(extractQuantitySlot("300kg")).toEqual({ value: 300, unit: "kilogram" });
  });

  it("没有数量就留空，不默认 100 米", () => {
    expect(extractQuantitySlot("报个价")).toBeNull();
  });
});

describe("理解卡字段：预填 + 待补", () => {
  it("名片：联系人/电话可预填，主营必须留空人工填", () => {
    const card = buildUnderstanding({ text: "拍名片建档", sources: [CARD] });
    const fields = new Map(card.fields.map((field) => [field.fieldName, field]));
    expect(fields.get("name")?.value).toBe("杭州青禾服饰有限公司");
    expect(fields.get("name")?.sourceKind).toBe("bizcard");
    expect(fields.get("contactPhone")?.value).toBe("13800138000");
    expect(fields.get("business")?.value).toBe("");
    expect(fields.get("business")?.pending).toBe(true);
    expect(fields.get("business")?.sourceKind).toBe("manual");
  });

  it("标签：成分可预填；品名/克重/门幅/批号即使 OCR 给了值也留空", () => {
    const card = buildUnderstanding({ text: "标签建样品", sources: [LABEL] });
    const fields = new Map(card.fields.map((field) => [field.fieldName, field]));
    expect(fields.get("composition")?.value).toBe("100% 棉");
    expect(fields.get("composition")?.pending).toBe(false);
    for (const name of ["name", "weight", "width", "lot"]) {
      expect(fields.get(name)?.value, name).toBe("");
      expect(fields.get(name)?.pending, name).toBe(true);
    }
  });

  it("OCR 失败时字段留空并明确提示，不编造", () => {
    const failed: InboundSourceInsight = {
      ...CARD,
      ocrStatus: "FAILED",
      fields: {},
      ocrText: null,
      failureCode: "LOW_CONFIDENCE",
    };
    const card = buildUnderstanding({ text: "拍名片建档", sources: [failed] });
    expect(card.fields.every((field) => field.value === "")).toBe(true);
    expect(card.pendingQuestions.join()).toContain("没识别出来");
    expect(inboundReadiness(card).ready).toBe(false);
  });
});

describe("纠正与执行门", () => {
  it("kind 判错时 revise 改对，补齐必填后 ready", () => {
    const first = buildUnderstanding({ text: "拍名片建档", sources: [CARD] });
    expect(first.kind).toBe("customer");
    const revised = reviseUnderstanding(first, { kind: "sample" }, [CARD]);
    expect(revised.kind).toBe("sample");
    expect(inboundReadiness(revised).ready).toBe(false);

    const filled = reviseUnderstanding(
      revised,
      { fields: [{ fieldName: "name", value: "32S 精梳棉" }] },
      [CARD],
    );
    expect(inboundReadiness(filled).ready).toBe(true);
    const name = filled.fields.find((field) => field.fieldName === "name");
    expect(name?.value).toBe("32S 精梳棉");
    expect(name?.status).toBe("EDITED");
    expect(name?.sourceKind).toBe("manual");
  });

  it("报价缺客户/样品/数量时停在待补，补齐后 ready", () => {
    const card = buildUnderstanding({ text: "这款报个价", sources: [LABEL] });
    expect(card.kind).toBe("quote");
    expect(inboundReadiness(card).ready).toBe(false);
    const filled = reviseUnderstanding(
      card,
      {
        slots: {
          customerId: "33333333-3333-4333-8333-333333333333",
          sampleId: "44444444-4444-4444-8444-444444444444",
          quantity: 500,
          unit: "meter",
        },
      },
      [LABEL],
    );
    expect(inboundReadiness(filled).ready).toBe(true);
  });
});
