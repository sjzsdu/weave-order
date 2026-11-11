import { describe, expect, it } from "vitest";
import { LocalStubEmbeddingProvider, createEmbeddingProvider } from "../src/platform/embedding";

describe("local stub embedding provider", () => {
  const provider = new LocalStubEmbeddingProvider();

  it("输出固定维度且 L2 归一化", async () => {
    const vector = await provider.embedText("高支棉 220g/m2");
    expect(vector).toHaveLength(provider.dimension);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("同一输入确定复现，不同输入不同", async () => {
    const a = await provider.embedText("高支棉");
    const b = await provider.embedText("高支棉");
    const c = await provider.embedText("涤纶");
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("图像输入同样确定复现", async () => {
    const image = { mimeType: "image/jpeg", base64: "aGVsbG8td2VhdmU=" };
    expect(await provider.embedImage(image)).toEqual(await provider.embedImage(image));
  });

  it("空文本 / 非法 base64 被拒绝", async () => {
    await expect(provider.embedText("   ")).rejects.toThrow(/非空文本/);
    await expect(provider.embedImage({ mimeType: "image/png", base64: "!!!!" })).rejects.toThrow(
      /base64 非法|内容为空/,
    );
  });

  it("通过工厂创建；未知 provider 显式报错而不是静默降级", () => {
    expect(createEmbeddingProvider("local-stub").name).toBe("local-stub-v1");
    expect(() => createEmbeddingProvider("openai")).toThrow(/尚未接入/);
  });
});
