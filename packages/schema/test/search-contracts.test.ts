import { describe, expect, it } from "vitest";
import {
  Money,
  T001SearchFabricByImageInput,
  T001SearchFabricByImageResult,
  T002SearchFabricBySpecInput,
  T002SearchFabricBySpecResult,
} from "../src";

const UUID_A = "123e4567-e89b-12d3-a456-426614174000";
const NOW = "2026-11-11T11:00:00.000Z";

const sample = {
  id: UUID_A,
  tenantId: UUID_A,
  code: "SMP-001",
  name: "高支棉 220g",
  composition: "100% 棉",
  weight: "220g/m2",
  unit: "meter" as const,
  costFloor: { amount: 1200, currency: "CNY" as const },
  status: "ACTIVE" as const,
  createdAt: NOW,
};

describe("Money 上限：超界在契约层拒绝", () => {
  it("接受最大安全整数分（约 9007 万亿元）", () => {
    expect(Money.safeParse({ amount: Number.MAX_SAFE_INTEGER, currency: "CNY" }).success).toBe(
      true,
    );
  });

  it("拒绝超过 MAX_SAFE_INTEGER 的金额", () => {
    expect(Money.safeParse({ amount: Number.MAX_SAFE_INTEGER + 2, currency: "CNY" }).success).toBe(
      false,
    );
  });

  it("仍然拒绝浮点分", () => {
    expect(Money.safeParse({ amount: 10.5, currency: "CNY" }).success).toBe(false);
  });
});

describe("T-001 search_fabric_by_image", () => {
  it("接受合法图像输入并填充默认 topK / minSimilarity", () => {
    const parsed = T001SearchFabricByImageInput.safeParse({
      image: { mimeType: "image/jpeg", base64: "aGVsbG8=" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.topK).toBe(5);
      expect(parsed.data.minSimilarity).toBe(0.5);
    }
  });

  it("拒绝空图像与未知字段", () => {
    expect(
      T001SearchFabricByImageInput.safeParse({
        image: { mimeType: "image/jpeg", base64: "" },
      }).success,
    ).toBe(false);
    expect(
      T001SearchFabricByImageInput.safeParse({
        image: { mimeType: "image/jpeg", base64: "aGVsbG8=" },
        storeToMemory: true,
      }).success,
    ).toBe(false);
  });

  it("接受直传后的 imageUrl，并填充默认参数", () => {
    const parsed = T001SearchFabricByImageInput.safeParse({
      imageUrl: "https://cdn.weaveorder.cn/fabric/abc.jpg",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.topK).toBe(5);
      expect(parsed.data.minSimilarity).toBe(0.5);
      expect("imageUrl" in parsed.data).toBe(true);
    }
  });

  it("base64 与 imageUrl 只能二选一，且拒绝非法 URL", () => {
    expect(
      T001SearchFabricByImageInput.safeParse({
        image: { mimeType: "image/jpeg", base64: "aGVsbG8=" },
        imageUrl: "https://cdn.weaveorder.cn/fabric/abc.jpg",
      }).success,
    ).toBe(false);
    expect(T001SearchFabricByImageInput.safeParse({ imageUrl: "not-a-url" }).success).toBe(false);
  });

  it("接受带相似度的结果，拒绝越界的相似度", () => {
    const ok = T001SearchFabricByImageResult.safeParse({
      ok: true,
      data: {
        embeddingModel: "local-stub-v1",
        dimension: 16,
        matches: [{ sample, score: 0.83 }],
      },
    });
    expect(ok.success).toBe(true);
    const bad = T001SearchFabricByImageResult.safeParse({
      ok: true,
      data: {
        embeddingModel: "local-stub-v1",
        dimension: 16,
        matches: [{ sample, score: 1.2 }],
      },
    });
    expect(bad.success).toBe(false);
  });
});

describe("T-002 search_fabric_by_spec", () => {
  it("接受关键词与成分过滤，默认 limit", () => {
    const parsed = T002SearchFabricBySpecInput.safeParse({ query: "棉" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.limit).toBe(20);
  });

  it("拒绝空关键词", () => {
    expect(T002SearchFabricBySpecInput.safeParse({ query: "" }).success).toBe(false);
  });

  it("结果必须说明命中字段", () => {
    const parsed = T002SearchFabricBySpecResult.safeParse({
      ok: true,
      data: { matches: [{ sample, score: 0.5, matchedOn: ["name", "composition"] }] },
    });
    expect(parsed.success).toBe(true);
    const missing = T002SearchFabricBySpecResult.safeParse({
      ok: true,
      data: { matches: [{ sample, score: 0.5 }] },
    });
    expect(missing.success).toBe(false);
  });
});
