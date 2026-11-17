import { describe, expect, it } from "vitest";
import { ApiError } from "@weave-order/core";
import { quoteToolNotice, requestNotice } from "../src/lib/quote-notice";

/** 后端的原始 message 一律不进 UI：这里的主要断言就是「分、行号」不出现。 */
describe("报价错误提示", () => {
  it("低于成本底线：给出可执行动作，不透传内部单位", () => {
    const notice = quoteToolNotice(
      {
        code: "KERNEL_REJECTED",
        message: "第 1 行单价低于成本底线/最低毛利：0 < 200（分）",
        reason: "PRICE_BELOW_COST_FLOOR",
      },
      { unitLabel: "米" },
    );
    expect(notice.title).toBe("单价偏低，这单还不能生成草稿");
    expect(notice.detail).toContain("合规价");
    expect(notice.action).toEqual({ label: "让报价助手建议单价", kind: "suggest-price" });
    expect(`${notice.title}${notice.detail}`).not.toMatch(/分|第 1 行|200/);
  });

  it("不知道最低价时不编造数字，仍给出下一步", () => {
    const notice = quoteToolNotice({
      code: "KERNEL_REJECTED",
      reason: "PRICE_BELOW_COST_FLOOR",
    });
    expect(notice.detail).not.toContain("¥");
    expect(notice.action?.kind).toBe("suggest-price");
  });

  it("数量单位不一致：告诉用户回上一步改单位", () => {
    const notice = quoteToolNotice(
      {
        code: "KERNEL_REJECTED",
        message: "第 1 行数量单位 yard 与样品 S-1 的单位 meter 不一致",
        reason: "UNIT_MISMATCH",
      },
      { unitLabel: "米" },
    );
    expect(notice.title).toContain("单位");
    expect(notice.detail).toContain("米");
    expect(notice.action).toBeUndefined();
  });

  it("其他工具失败也落到可读短句", () => {
    expect(quoteToolNotice({ code: "CUSTOMER_NOT_FOUND" }).title).toContain("客户");
    expect(quoteToolNotice({ code: "INVALID_INPUT" }).title).toContain("信息");
    expect(quoteToolNotice({ code: "SOMETHING_NEW" }).title).toBe("没能生成报价草稿");
  });

  it("网络异常按状态码给出不同提示，不透传原始 message", () => {
    expect(requestNotice(new ApiError(401, "UNAUTHORIZED", "缺少 Bearer 令牌"), "失败").title).toBe(
      "登录已过期",
    );
    expect(requestNotice(new ApiError(500, "INTERNAL", "boom"), "失败").title).toBe(
      "服务暂时不可用",
    );
    const offline = requestNotice(new TypeError("Failed to fetch"), "生成草稿失败");
    expect(offline.title).toBe("生成草稿失败");
    expect(offline.detail).toContain("网络");
  });
});
