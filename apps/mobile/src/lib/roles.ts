/**
 * 「今日」按角色变（同一套组件、不同块排序）。
 * 角色只影响首页信息密度，不参与权限判定 —— 权限由服务端 membership 决定。
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

export interface RoleBlock {
  id: "decide" | "business" | "exceptions" | "customers" | "shipments" | "finance" | "samples";
  title: string;
  hint: string;
}

const BLOCKS: Record<RoleBlock["id"], RoleBlock> = {
  decide: { id: "decide", title: "待我决定", hint: "批准或驳回，金额与校验由服务端完成" },
  business: { id: "business", title: "经营一句话", hint: "今天哪里不对，比昨天怎么样" },
  exceptions: { id: "exceptions", title: "异常", hint: "交期、物流、签收，只列需要动的" },
  customers: { id: "customers", title: "我的客户", hint: "最近沟通、待回访、快速报价" },
  shipments: { id: "shipments", title: "在途寄样 / 生产", hint: "扫码录运单、拍签收、更新进度" },
  finance: { id: "finance", title: "逾期与待核销", hint: "本月应收、差异对账" },
  samples: { id: "samples", title: "借还 / 盘点", hint: "货架与库存预警" },
};

/** 第一屏 → 第二屏 → 其他；快捷动作单独定义。 */
const ROLE_BLOCKS: Record<Role, RoleBlock["id"][]> = {
  sales: ["decide", "customers", "exceptions"],
  owner: ["business", "decide", "exceptions"],
  followup: ["exceptions", "shipments", "decide"],
  sampleRoom: ["samples", "decide", "exceptions"],
  finance: ["finance", "decide", "exceptions"],
};

export const ROLE_QUICK_ACTIONS: Record<Role, string[]> = {
  sales: ["paste", "camera", "scan"],
  owner: ["decide", "report", "paste", "scan"],
  followup: ["scan", "signature", "camera", "decide"],
  sampleRoom: ["scan", "camera", "sample", "decide"],
  finance: ["receipt", "report", "decide", "scan"],
};

export function blocksForRole(role: Role): RoleBlock[] {
  return ROLE_BLOCKS[role].map((id) => BLOCKS[id]);
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
