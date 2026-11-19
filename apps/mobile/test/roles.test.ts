import { describe, expect, it } from "vitest";
import { ROLES, ROLE_LABEL, isRole } from "../src/lib/roles";

describe("身份（角色）", () => {
  it("每个角色都有中文标签，且标签唯一", () => {
    const labels = ROLES.map((role) => ROLE_LABEL[role]);
    expect(labels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("只接受已知角色", () => {
    expect(isRole("sales")).toBe(true);
    expect(isRole("owner")).toBe(true);
    expect(isRole("admin")).toBe(false);
    expect(isRole(null)).toBe(false);
    expect(isRole(42)).toBe(false);
  });

  it("待办不再按角色换块：roles 只导出身份相关的东西", () => {
    // 防止有人把「分角色块表」加回来：那正是 WAN-183 删掉的占位块来源。
    expect(Object.keys(ROLE_LABEL).sort()).toEqual([...ROLES].sort());
  });
});
