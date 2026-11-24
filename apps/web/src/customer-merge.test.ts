import { describe, expect, it } from "vitest";
import { ApiError } from "@weave-order/core";
import { isPreviewExpired, mergeErrorMessage } from "./customer-merge";

describe("mergeErrorMessage", () => {
  it("后端 reason 映射成人话，而不是只显示状态码", () => {
    expect(
      mergeErrorMessage(
        new ApiError(400, "KERNEL_REJECTED", "不能把客户合并到自己", { reason: "MERGE_SELF" }),
      ),
    ).toBe("不能把客户合并到自己。");
    expect(
      mergeErrorMessage(
        new ApiError(400, "KERNEL_REJECTED", "已归档客户不能再合并", {
          reason: "MERGE_SOURCE_ARCHIVED",
        }),
      ),
    ).toBe("已归档客户不能再合并。");
    expect(
      mergeErrorMessage(
        new ApiError(400, "KERNEL_REJECTED", "只能合并到可用客户", {
          reason: "MERGE_TARGET_NOT_AVAILABLE",
        }),
      ),
    ).toBe("只能合并到可用客户。");
  });

  it("预览票据过期 / 目标不一致提示重新预览，不把用户卡死", () => {
    const msg = mergeErrorMessage(
      new ApiError(400, "KERNEL_REJECTED", "预览已过期或无效，请重新预览", {
        reason: "MERGE_TOKEN_INVALID",
      }),
    );
    expect(msg).toContain("重新预览");
    expect(
      mergeErrorMessage(
        new ApiError(400, "KERNEL_REJECTED", "x", { reason: "MERGE_PREVIEW_MISMATCH" }),
      ),
    ).toContain("重新预览");
  });

  it("撤销场景与权限拒绝分别给出口径", () => {
    expect(
      mergeErrorMessage(
        new ApiError(400, "KERNEL_REJECTED", "x", { reason: "MERGE_UNDO_NOT_AVAILABLE" }),
      ),
    ).toBe("没有可撤销的合并，或已经撤销过了。");
    expect(mergeErrorMessage(new ApiError(403, "PERMISSION_DENIED", "denied"))).toBe(
      "当前角色没有合并客户的权限。",
    );
  });

  it("未知错误回退到后端中文 message 或通用兜底", () => {
    expect(mergeErrorMessage(new ApiError(500, "INTERNAL", "服务开小差了"))).toBe("服务开小差了");
    expect(mergeErrorMessage(null)).toBe("操作失败，请稍后重试。");
  });
});

describe("isPreviewExpired", () => {
  it("过期时间在现在之前判定为过期", () => {
    expect(isPreviewExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
  });

  it("未来时间判定为未过期", () => {
    expect(isPreviewExpired(new Date(Date.now() + 60_000).toISOString())).toBe(false);
  });

  it("无法解析的时间视为已过期（安全侧）", () => {
    expect(isPreviewExpired("not-a-date")).toBe(true);
  });
});
