import { describe, expect, it } from "vitest";
import { sanitizeUserNotice } from "../src/platform/notice-text";

/**
 * WAN-204：意图卡上的降级说明必须是用户语言。
 * 新生成的文案要洗，已经落库的历史行读出来也要洗。
 */
describe("用户可见提示清洗", () => {
  it("保留正常的业务说明原样", () => {
    expect(sanitizeUserNotice("还差：客户（请选择这条询价属于哪个客户）。")).toBe(
      "还差：客户（请选择这条询价属于哪个客户）。",
    );
  });

  it("丢掉历史数据里含 HTTP / 令牌的整句，保留缺失项与重试提示", () => {
    const raw =
      "还差：客户（请选择这条询价属于哪个客户）。模型网关不可用：模型网关拒绝了本次调用（HTTP 403）：令牌可能无权使用当前模型。本次已用本地规则整理。原话已保留，补齐后重试即可。";
    const notice = sanitizeUserNotice(raw);
    expect(notice).toContain("还差：客户");
    expect(notice).toContain("本次已用本地规则整理");
    expect(notice).toContain("原话已保留");
    expect(notice).not.toContain("HTTP");
    expect(notice).not.toContain("令牌");
    expect(notice).not.toContain("模型网关");
  });

  it("整条都是内部细节时给出可理解的整体说明", () => {
    const notice = sanitizeUserNotice("模型网关不可用：HTTP 403 request id abc123");
    expect(notice).toContain("模型服务暂时不可用");
    expect(notice).not.toContain("HTTP");
    expect(notice).not.toContain("abc123");
  });

  it("空值不制造文案，超长按契约截到 500 字", () => {
    expect(sanitizeUserNotice(null)).toBeNull();
    expect(sanitizeUserNotice("   ")).toBeNull();
    expect(sanitizeUserNotice("正常说明".repeat(200))?.length).toBe(500);
  });
});
