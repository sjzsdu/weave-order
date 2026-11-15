import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  DETAIL_THUMB_WIDTH,
  WALL_THUMB_WIDTH,
  reencodeOversizedOriginal,
  renderThumbnail,
  thumbObjectKey,
} from "../src/platform/thumbnail";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SAMPLE = "22222222-2222-4222-8222-222222222222";
const IMAGE = "33333333-3333-4333-8333-333333333333";

async function jpeg(width = 1200, height = 900): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 90, b: 70 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

describe("缩略图 key 规则（延续 S1 契约）", () => {
  it("320 / 640 都落在 thumbs/<imageId>_<width>.webp", () => {
    expect(thumbObjectKey(TENANT, SAMPLE, IMAGE, WALL_THUMB_WIDTH)).toBe(
      `tenant/${TENANT}/samples/${SAMPLE}/thumbs/${IMAGE}_320.webp`,
    );
    expect(thumbObjectKey(TENANT, SAMPLE, IMAGE, DETAIL_THUMB_WIDTH)).toBe(
      `tenant/${TENANT}/samples/${SAMPLE}/thumbs/${IMAGE}_640.webp`,
    );
  });

  it("两档 key 不相同（不会互相覆盖）", () => {
    expect(thumbObjectKey(TENANT, SAMPLE, IMAGE, 320)).not.toBe(
      thumbObjectKey(TENANT, SAMPLE, IMAGE, 640),
    );
  });
});

describe("派生渲染", () => {
  it("输出 webp 且宽度不超过目标值", async () => {
    const output = await renderThumbnail(await jpeg(), 320);
    const meta = await sharp(output).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(320);
    expect(output.length).toBeLessThan((await jpeg()).length);
  });

  it("小图不放大", async () => {
    const small = await jpeg(100, 80);
    const meta = await sharp(await renderThumbnail(small, 320)).metadata();
    expect(meta.width).toBe(100);
  });

  it("不可解码的字节明确失败，而不是返回空图", async () => {
    await expect(renderThumbnail(Buffer.from("not-an-image"), 320)).rejects.toThrow("无法解码");
  });
});

describe("超大原图重编码", () => {
  it("保持原格式与 key 语义，只变小", async () => {
    const source = await jpeg(1600, 1200);
    const reencoded = await reencodeOversizedOriginal(source, "image/jpeg");
    expect(reencoded.contentType).toBe("image/jpeg");
    expect(reencoded.width).toBe(1600);
    expect(reencoded.height).toBe(1200);
    expect(reencoded.bytes.length).toBeLessThan(source.length);
    expect((await sharp(reencoded.bytes).metadata()).format).toBe("jpeg");
  });

  it("png 仍是 png（不会出现 .png 装 webp 的契约裂缝）", async () => {
    const source = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const reencoded = await reencodeOversizedOriginal(source, "image/png");
    expect(reencoded.contentType).toBe("image/png");
    expect((await sharp(reencoded.bytes).metadata()).format).toBe("png");
  });

  it("不支持的格式显式报错，而不是默认产出 jpeg 字节", async () => {
    const source = await jpeg(100, 100);
    await expect(reencodeOversizedOriginal(source, "image/gif")).rejects.toThrow("不支持重编码");
    await expect(reencodeOversizedOriginal(source, "image/avif")).rejects.toThrow("不支持重编码");
  });
});
