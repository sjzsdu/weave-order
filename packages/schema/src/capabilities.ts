import { z } from "zod";
import type { DataScope, MemberRole } from "./tenancy";

/**
 * 角色 → 能力：全产品唯一的权限事实源。
 *
 * 为什么必须只有这一份：同一组角色规则以前散在后端 4 处（成本可见、样品写、
 * 跨人定价、审批阈值）和前端 1 处（全景隐藏订单）。逻辑只有一行，但只要有
 * 第二份拷贝，加角色或调权限时就一定有一侧漏改——表现为「前端藏了按钮，后端
 * 还能调」或「前端显示了，后端 403」。所以规定：
 *
 * - 任何「某角色能不能 X」的判断，都只能查本文件；
 * - 纯数据 + 纯函数，零依赖（只依赖 zod 与 tenancy 的类型），前后端同包引用；
 * - 新增能力 = 加一个枚举值 + 一行角色清单，不改调用点。
 *
 * 数据范围（`dataScope`）与审批额度暂不参与能力判定：它们是「同一能力下看得到
 * 多少数据」的过滤条件，由 API 的数据范围层处理，不改变「能不能做这个动作」。
 * 等到出现真正按范围区分能力的需求（例如团队管理员），再在这里加规则，
 * 而不是在调用点写 if。
 */

/**
 * 能力枚举。命名统一 `领域.动作`，动词用主动语态，避免 `canXxx` 这种实现细节泄漏。
 *
 * - `quote.write` 与 `quote.approve` 故意分开：报价矩阵里它们是两条规则，
 *   「能改稿」不等同「能批到自己满意的额度」，额度另由 approval-policy 推导。
 * - `quote.price.override` 指「越过建议价直接定价、不再触发上级复核」，
 *   所以只有 OWNER / MANAGER；SALES 可以改价，但改幅超阈值仍会被升级审批。
 * - `pricing.policy.edit.company` 是 `pricing.policy.edit` 的收紧版：
 *   公司/系统层策略只有 OWNER 能改，团队/客户/个人层 MANAGER 也能改。
 */
export const Capability = z.enum([
  "sample.write",
  "sample.cost.view",
  "quote.write",
  "quote.approve",
  "quote.price.override",
  "pricing.cross_person.read",
  "pricing.policy.edit",
  "pricing.policy.edit.company",
  "member.invite",
  "settings.edit",
  "print.template.publish.html",
  "receivable.read",
  "panorama.orders.view",
  /** 全公司操作日志（含导出）；没有它的角色只能看自己的操作。 */
  "audit.read.all",
  "audit.read.own",
  /** 联系人手机/邮箱明文；缺失时读模型层掩码（仅 VIEWER 缺失）。 */
  "contact.pii.view",
  "quote.workbench.view",
  "field_options.manage",
  /** 数据导入入口；缺它的人看不到设置里的导入分栏。 */
  "data.import",
  /** 用量与订阅只读可见（账单由平台侧维护）。 */
  "billing.view",
]);
export type Capability = z.infer<typeof Capability>;

/**
 * 能力 → 拥有它的角色。以能力为键（而不是角色为键）是为了让这张表和
 * `docs/product-design.md` §3.3 的权限矩阵逐行对齐：评审时一行对一行，
 * 加角色只会在需要的行上出现。
 *
 * VIEWER 是只读席位：读类能力（应收、全景）给，写/批/配置不给；
 * 成本底线仍按收敛前的白名单（owner / manager / finance / sample_admin）把关。
 * MERCHANDISER / SAMPLE_ADMIN 是执行岗：不碰价格与权限。
 */
export const CAPABILITY_ROLES: Readonly<Record<Capability, readonly MemberRole[]>> = {
  "sample.write": ["OWNER", "MANAGER", "SAMPLE_ADMIN"],
  "sample.cost.view": ["OWNER", "MANAGER", "FINANCE", "SAMPLE_ADMIN"],
  "quote.write": ["OWNER", "MANAGER", "SALES"],
  "quote.approve": ["OWNER", "MANAGER", "SALES"],
  "quote.price.override": ["OWNER", "MANAGER"],
  "pricing.cross_person.read": ["OWNER", "MANAGER"],
  "pricing.policy.edit": ["OWNER", "MANAGER"],
  "pricing.policy.edit.company": ["OWNER"],
  "member.invite": ["OWNER", "MANAGER"],
  "settings.edit": ["OWNER", "MANAGER"],
  "print.template.publish.html": ["OWNER"],
  "receivable.read": ["OWNER", "MANAGER", "SALES", "FINANCE", "VIEWER"],
  // 财务的默认工作面是应收，订单不在一级入口；其余角色都能看订单漏斗。
  "panorama.orders.view": ["OWNER", "MANAGER", "SALES", "MERCHANDISER", "SAMPLE_ADMIN", "VIEWER"],
  // 审计范围：OWNER/MANAGER 看全公司，其余角色只能看自己的操作（服务端强制过滤）。
  "audit.read.all": ["OWNER", "MANAGER"],
  "audit.read.own": [
    "OWNER",
    "MANAGER",
    "SALES",
    "MERCHANDISER",
    "SAMPLE_ADMIN",
    "FINANCE",
    "VIEWER",
  ],
  // 联系人 PII：只对观察者席位掩码。跟单要打电话确认交期、样品管理要寄样地址，
  // 掩码只会把人赶回微信，数据反而流出系统（巧匠 WAN-174 第 3 条）。
  "contact.pii.view": ["OWNER", "MANAGER", "SALES", "MERCHANDISER", "SAMPLE_ADMIN", "FINANCE"],
  // 报价工作台：销售写、只读席位读；跟单与财务的日常工作面不在这里。
  "quote.workbench.view": ["OWNER", "MANAGER", "SALES", "VIEWER"],
  // 字段选项是公司共享字典，产品结论是任何成员都能增删改合并排序。
  "field_options.manage": [
    "OWNER",
    "MANAGER",
    "SALES",
    "MERCHANDISER",
    "SAMPLE_ADMIN",
    "FINANCE",
    "VIEWER",
  ],
  "data.import": ["OWNER", "MANAGER", "SALES", "MERCHANDISER", "SAMPLE_ADMIN"],
  "billing.view": ["OWNER"],
};

/**
 * 判定所需的最小成员信息。
 *
 * 显式声明而不是直接收 `Membership`：服务端有些路径（系统任务、智能体内核）
 * 只有 role，没有完整成员行；能力本身也不该依赖 membership id / status。
 */
export interface CapabilitySubject {
  role: MemberRole;
  /** 预留：未来若出现按范围区分的能力，规则写在本文件而不是调用点。 */
  dataScope?: DataScope;
  /** 预留：额度影响的是审批档位，不是能力集合。 */
  approvalLimitAmount?: number | null;
}

/** 拥有某能力的角色清单（只读，勿在调用点改写）。 */
export function rolesWithCapability(capability: Capability): readonly MemberRole[] {
  return CAPABILITY_ROLES[capability];
}

/**
 * 角色是否具备某能力。
 *
 * 同时接受 `MemberRole` 与 `CapabilitySubject`：后端内核路径手里常只有 role，
 * 认证/控制器路径手里是完整 Membership，两处都该查同一张表而不是各写一份 if。
 */
export function hasCapability(
  subject: MemberRole | CapabilitySubject,
  capability: Capability,
): boolean {
  const role = typeof subject === "string" ? subject : subject.role;
  return CAPABILITY_ROLES[capability].includes(role);
}

/** 某成员的全部能力。前端 `/api/auth/me` 直接返回这个数组。 */
export function roleCapabilities(subject: CapabilitySubject): Capability[] {
  return Capability.options.filter((capability) => hasCapability(subject, capability));
}

/**
 * 审批等级阶梯：能力回答「能不能批」，等级回答「能批到哪一档」。
 *
 * 只有具备 `quote.approve` 的角色才在阶梯上；不在表里的角色返回 null，
 * 调用方据此 fail-closed，而不是给一个「看起来能批」的等级。
 */
const ROLE_APPROVAL_LEVEL = {
  OWNER: "OWNER",
  MANAGER: "MANAGER",
  SALES: "SALES",
} as const satisfies Partial<Record<MemberRole, "OWNER" | "MANAGER" | "SALES">>;

export type RoleApprovalLevel = (typeof ROLE_APPROVAL_LEVEL)[keyof typeof ROLE_APPROVAL_LEVEL];

export function approvalLevelForRole(role: MemberRole): RoleApprovalLevel | null {
  if (!hasCapability(role, "quote.approve")) return null;
  return role in ROLE_APPROVAL_LEVEL
    ? ROLE_APPROVAL_LEVEL[role as keyof typeof ROLE_APPROVAL_LEVEL]
    : null;
}
