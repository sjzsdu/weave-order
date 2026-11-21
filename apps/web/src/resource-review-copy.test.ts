import { describe, expect, it } from "vitest";
import { confirmErrorMessage } from "./resource-review-copy";

describe("确认可用失败文案", () => {
  it("把字段键翻成用户能认的名字，并说明下一步", () => {
    const message = confirmErrorMessage(
      new Error("还有字段待确认：name, weight"),
    );
    expect(message).toBe(
      "还有字段待确认：名称、克重。先点「逐字段确认」再确认可用。",
    );
    expect(message).not.toContain("name");
  });

  it("没有字段前缀时原样保留服务端原因", () => {
    expect(confirmErrorMessage(new Error("该样品不是草稿"))).toBe(
      "该样品不是草稿",
    );
  });
});
