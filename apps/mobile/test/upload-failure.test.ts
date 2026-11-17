import { describe, expect, it } from "vitest";
import {
  MediaUploadError,
  buildSampleSaveFailureMessage,
  isMediaUploadError,
  toMediaUploadError,
  uploadFailureMessage,
  uploadHttpError,
} from "../src/lib/upload-failure";

describe("上传失败分类", () => {
  it("浏览器 CORS / 断网的 TypeError 归类为 network，而不是离线", () => {
    const error = toMediaUploadError(new TypeError("Failed to fetch"));
    expect(error).toBeInstanceOf(MediaUploadError);
    expect(error.kind).toBe("network");
    expect(error.message).toContain("上传失败");
    expect(error.message).not.toMatch(/Failed to fetch/);
    expect(isMediaUploadError(error)).toBe(true);
  });

  it("对象存储 403 指向 CORS / 权限，而不是让用户重试到天荒地老", () => {
    const error = uploadHttpError(403);
    expect(error.kind).toBe("http");
    expect(error.status).toBe(403);
    expect(error.message).toContain("CORS");
  });

  it("其它非 2xx 保留状态码并提示重试", () => {
    const error = uploadHttpError(500);
    expect(error.status).toBe(500);
    expect(error.message).toContain("HTTP 500");
    expect(error.message).toContain("重试");
  });

  it("已分类的错误不被二次包装", () => {
    const original = new MediaUploadError("原始原因", "http", { status: 502 });
    expect(toMediaUploadError(original)).toBe(original);
    expect(uploadFailureMessage(original)).toBe("原始原因");
  });

  it("未知错误回退到调用方给的兜底文案", () => {
    expect(uploadFailureMessage(null, "上传或记录失败")).toBe("上传或记录失败");
    expect(uploadFailureMessage(undefined)).toBe("图片上传失败，请重试");
  });
});

describe("建样品失败文案", () => {
  it("回滚成功时告诉用户记录已撤销、照片还在本页", () => {
    const message = buildSampleSaveFailureMessage({
      reason: "图片上传失败：无法连接存储服务",
      rolledBack: true,
      name: "QA走查样品",
      code: "SP-1",
    });
    expect(message).toContain("已撤销");
    expect(message).toContain("照片还在本页");
    expect(message).not.toContain("可能已创建");
  });

  it("回滚失败时给出编码，让用户去样品库确认并补图", () => {
    const message = buildSampleSaveFailureMessage({
      reason: "图片上传失败",
      rolledBack: false,
      name: "QA走查样品",
      code: "SP-1",
    });
    expect(message).toContain("可能已创建（SP-1）");
    expect(message).toContain("样品库");
  });
});
