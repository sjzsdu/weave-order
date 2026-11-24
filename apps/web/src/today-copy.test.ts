import { describe, expect, it } from "vitest";
import { todayHeadline } from "./today-copy";

describe("工作台标题四态", () => {
  it("有智能体产出时用 todayAgentDoneCount", () => {
    expect(todayHeadline({ agentDone: 3, pendingCount: 2, isNewWorkspace: false })).toBe(
      "今天，小织替你做了 3 件事",
    );
  });

  /**
   * WAN-212 走查抓到的自相矛盾：标题说「今天没有新的智能体动态」，
   * 同屏徽章写着「草稿待批 2」。草稿在等人决定就是活，不能算没动静。
   */
  it("无产出但有待办时说清在等什么，不说没动态、也不说替你做了", () => {
    const headline = todayHeadline({ agentDone: 0, pendingCount: 2, isNewWorkspace: false });
    expect(headline).toBe("有 2 件等你决定");
    expect(headline).not.toContain("没有新的智能体动态");
    expect(headline).not.toContain("替你做了");
  });

  it("待办件数与传入的 pendingCount 一致", () => {
    for (const pendingCount of [1, 2, 5, 37]) {
      const headline = todayHeadline({ agentDone: 0, pendingCount, isNewWorkspace: false });
      expect(headline).toContain(String(pendingCount));
    }
  });

  it("有待办时不把新用户引导排在前面", () => {
    const headline = todayHeadline({ agentDone: 0, pendingCount: 1, isNewWorkspace: true });
    expect(headline).toBe("有 1 件等你决定");
    expect(headline).not.toContain("先把客户和样品放进来");
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
