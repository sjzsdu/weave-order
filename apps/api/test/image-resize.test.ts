import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { resizeForEmbedding } from "../src/platform/image-resize";

async function jpegOf(width: number, height: number): Promise<{ mimeType: string; base64: string }> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 180, g: 40, b: 40 } },
  })
    .jpeg()
    .toBuffer();
  return { mimeType: "image/jpeg", base64: buffer.toString("base64") };
}

async function dimensions(image: { base64: string }): Promise<{ width: number; height: number }> {
  const meta = await sharp(Buffer.from(image.base64, "base64")).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

describe("服务端缩图（送多模态模型前）", () => {
  it("长边压到 512，短边按比例，统一转 JPEG", async () => {
    const source = await jpegOf(1600, 1200);
    const output = await resizeForEmbedding(source, 512);
    expect(output.mimeType).toBe("image/jpeg");
    const size = await dimensions(output);
    expect(Math.max(size.width, size.height)).toBe(512);
    // 短边保持比例（1200/1600 × 512 = 384）
    expect(Math.min(size.width, size.height)).toBe(384);
    // 体积明显变小：这正是「成本降 4~19 倍」的来源。
    expect(output.base64.length).toBeLessThan(source.base64.length);
  });

  it("小图不放大（否则白烧 token）", async () => {
    const source = await jpegOf(200, 150);
    const output = await resizeForEmbedding(source, 512);
    const size = await dimensions(output);
    expect(size).toEqual({ width: 200, height: 150 });
  });

  it("maxEdge=0 原样返回（测试用假图片时关闭）", async () => {
    const fake = { mimeType: "image/jpeg", base64: "not-a-real-image" };
    await expect(resizeForEmbedding(fake, 0)).resolves.toEqual(fake);
  });

  it("无法解码时明确报错，不把坏字节塞给模型", async () => {
    await expect(
      resizeForEmbedding({ mimeType: "image/jpeg", base64: Buffer.from("hello").toString("base64") }, 512),
    ).rejects.toThrow(/无法解码\/缩放/);
  });
});
