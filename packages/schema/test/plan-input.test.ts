import { describe, expect, it } from "vitest";
import { Plan, PlanInput } from "../src";

/**
 * 新建套餐入参：WAN-164 让 owner 能在空控制面里自助建套餐，
 * 这里固定住「哪些代码合法 / 默认值如何补 / 席位上下限关系」这几个契约。
 */
describe("PlanInput", () => {
  const base = { code: "GROWTH", name: "成长版", tier: 2 };

  it("补默认值后能通过 Plan 形状校验", () => {
    const parsed = PlanInput.parse(base);
    expect(Plan.parse({ ...parsed, status: parsed.status })).toBeTruthy();
    expect(parsed.seatMin).toBe(1);
    expect(parsed.seatMax).toBeNull();
    expect(parsed.agentActionsQuota).toBe(0);
    expect(parsed.storageGb).toBe(0);
    expect(parsed.features).toEqual({});
    expect(parsed.status).toBe("ACTIVE");
  });

  it("拒绝小写 / 带空格 / 带横线的套餐代码", () => {
    for (const code of ["growth", "GR OWTH", "gro-wth", "1GROWTH", "G"]) {
      expect(PlanInput.safeParse({ ...base, code }).success, `${code} 不应通过`).toBe(false);
    }
  });

  it("接受大写字母、数字与下划线", () => {
    for (const code of ["PRO", "PRO_PLUS", "TIER2"]) {
      expect(PlanInput.safeParse({ ...base, code }).success, `${code} 应通过`).toBe(true);
    }
  });

  it("席位上限定不能小于下限", () => {
    expect(PlanInput.safeParse({ ...base, seatMin: 10, seatMax: 5 }).success).toBe(false);
    expect(PlanInput.safeParse({ ...base, seatMin: 5, seatMax: 5 }).success).toBe(true);
    expect(PlanInput.safeParse({ ...base, seatMin: 5, seatMax: null }).success).toBe(true);
  });

  it("拒绝未知字段（strict），避免前端拼错字段被静默忽略", () => {
    expect(PlanInput.safeParse({ ...base, seats: 10 }).success).toBe(false);
  });
});
