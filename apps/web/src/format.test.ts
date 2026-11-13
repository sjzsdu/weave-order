import { describe, expect, it } from "vitest";
import { actionLabel, KIND_LABEL, relativeTime, STATUS_LABEL } from "./format";

describe("桌面 Web 文案", () => {
  it("审计动作说人话", () => {
    expect(actionLabel("QUOTE_DRAFT_GENERATED")).toBe("生成了报价草稿");
    expect(actionLabel("UNKNOWN_ACTION")).toBe("UNKNOWN_ACTION");
  });

  it("单据类型与状态有中文标签", () => {
    expect(KIND_LABEL.quote).toBe("报价");
    expect(STATUS_LABEL.DRAFT).toBe("草稿");
  });

  it("相对时间对非法输入不崩", () => {
    expect(relativeTime("not-a-date")).toBe("not-a-date");
  });
});
