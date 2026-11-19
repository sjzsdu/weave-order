/**
 * 身份（角色）只用于个性化，不参与权限判定 —— 权限由服务端 membership 决定。
 *
 * 角色的「切换」入口现在只在我的页；待办页不再按角色换块，所以这里不再保留
 * 分角色的块表和快捷动作表（原来会落到「移动端只做现场动作」的占位块）。
 */

export const ROLES = ["sales", "owner", "followup", "sampleRoom", "finance"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  sales: "业务员",
  owner: "老板",
  followup: "跟单",
  sampleRoom: "样品间",
  finance: "财务",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
