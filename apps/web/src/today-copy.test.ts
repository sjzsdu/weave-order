import { describe, expect, it } from "vitest";
import { todayHeadline } from "./today-copy";

describe("工作台标题三态", () => {
  it("有智能体产出时用 todayAgentDoneCount", () => {
    expect(todayHeadline({ agentDone: 3, pendingCount: 2, isNewWorkspace: false })).toBe(
      "今天，小织替你做了 3 件事",
    );
  });

  it("无产出但有待办时不说「替你做了」", () => {
    const headline = todayHeadline({ agentDone: 0, pendingCount: 2, isNewWorkspace: false });
    expect(headline).toBe("今天没有新的智能体动态");
    expect(headline).not.toContain("替你做了");
  });

  it("全空新用户给开张引导，且不出现任何数字", () => {
    const headline = todayHeadline({ agentDone: 0, pendingCount: 0, isNewWorkspace: true });
    expect(headline).toBe("欢迎，先把客户和样品放进来");
    expect(headline).not.toContain("替你做了");
    expect(headline).not.toMatch(/\d/);
  });

  it("有数据但今天没动静时也不假报产出", () => {
    expect(todayHeadline({ agentDone: 0, pendingCount: 0, isNewWorkspace: false })).toBe(
      "今天没有新的智能体动态",
    );
  });
});
