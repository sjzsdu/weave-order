import { describe, expect, it } from "vitest";
import { ROLES, blocksForRole, isRole } from "../src/lib/roles";

describe("角色化今日", () => {
  it("老板第一屏是经营一句话，业务员第一屏是待决定", () => {
    expect(blocksForRole("owner")[0]?.id).toBe("business");
    expect(blocksForRole("sales")[0]?.id).toBe("decide");
    expect(blocksForRole("followup")[0]?.id).toBe("exceptions");
    expect(blocksForRole("finance")[0]?.id).toBe("finance");
  });

  it("每个角色都有 3 个块且顺序稳定", () => {
    for (const role of ROLES) {
      expect(blocksForRole(role)).toHaveLength(3);
    }
  });

  it("只接受已知角色", () => {
    expect(isRole("sales")).toBe(true);
    expect(isRole("admin")).toBe(false);
    expect(isRole(null)).toBe(false);
  });
});
