import {
  ApprovalLevel,
  ApprovalRequirement,
  EscalationReason,
  PricingKey,
  ResolvedPricingValue,
  approvalLevelRank,
  hasQuoteEditCapability,
  roleApprovalLevel,
} from "@weave-order/schema";
import type { MemberRole, PricingContext } from "@weave-order/schema";
import { numericValue } from "./pricing.service";
import type { PricingService } from "./pricing.service";
import { KernelError } from "./errors";
import { isProductionLike } from "../platform/runtime-mode";

/**
 * 审批分级与改幅升级的纯函数层。
 *
 * 阈值本身来自 pricing_policies（金额限额 / 改幅百分比 / 改幅金额），
 * 这里只做「读到的生效值 → 需要谁批」的确定性推导，不碰数据库。
 */

const APPROVAL_KEYS = [
  "approval.sales.limit",
  "approval.manager.limit",
  "approval.owner.limit",
  "pricing.reprice_escalation_pct",
  "pricing.reprice_escalation_amount",
] as const satisfies readonly PricingKey[];

type NumericResolver = (value: ResolvedPricingValue["value"]) => number | null;

export interface RequirementInput {
  amountCents: number;
  /** 智能体原稿总额；没有原稿时传 null，不计算改幅。 */
  baselineCents: number | null;
  policies: Partial<Record<PricingKey, ResolvedPricingValue>>;
  /** 额外强制升级原因（例如成本底线被策略抬高）。 */
  extraReasons?: EscalationReason[];
  numeric?: NumericResolver;
}

function limitOf(
  policies: Partial<Record<PricingKey, ResolvedPricingValue>>,
  key: PricingKey,
  fallback: number | null,
  numeric: NumericResolver,
): number | null {
  const resolved = policies[key];
  if (!resolved) return fallback;
  return numeric(resolved.value);
}

/** 金额落在哪一级审批。owner 上限为 null 表示无上限。 */
function levelForAmount(
  amountCents: number,
  policies: Partial<Record<PricingKey, ResolvedPricingValue>>,
  numeric: NumericResolver,
): ApprovalLevel {
  const sales = limitOf(policies, "approval.sales.limit", 5_000_000, numeric);
  const manager = limitOf(policies, "approval.manager.limit", 20_000_000, numeric);
  if (sales !== null && amountCents <= sales) return "SALES";
  if (manager !== null && amountCents <= manager) return "MANAGER";
  return "OWNER";
}

const LEVEL_TO_ROLE: Record<ApprovalLevel, MemberRole> = {
  SALES: "SALES",
  MANAGER: "MANAGER",
  OWNER: "OWNER",
};

/** 推导审批要求：金额阈值 + 改幅阈值取较高者。 */
export function computeRequirement(input: RequirementInput): ApprovalRequirement {
  const numeric = input.numeric ?? numericValue;
  let level = levelForAmount(input.amountCents, input.policies, numeric);
  const reasons = new Set<EscalationReason>(input.extraReasons ?? []);

  let changePctBps: number | null = null;
  let changeAmountCents: number | undefined;
  const baseline = input.baselineCents;
  if (baseline !== null && baseline > 0) {
    // 涨价/降价都按绝对改幅判阈值，但把带符号的差额一并带出去，
    // 审批卡可以直接说「从 X 涨到 Y」，不用前端自己再算一遍。
    changeAmountCents = input.amountCents - baseline;
    const delta = Math.abs(changeAmountCents);
    changePctBps = Math.round((delta * 10_000) / baseline);

    const pctThreshold = limitOf(input.policies, "pricing.reprice_escalation_pct", 5, numeric);
    if (pctThreshold !== null && changePctBps > Math.round(pctThreshold * 100)) {
      reasons.add("REPRICE_PCT_EXCEEDED");
    }
    const amountThreshold = limitOf(
      input.policies,
      "pricing.reprice_escalation_amount",
      1_000_000,
      numeric,
    );
    if (amountThreshold !== null && delta > amountThreshold) {
      reasons.add("REPRICE_AMOUNT_EXCEEDED");
    }
    if (reasons.has("REPRICE_PCT_EXCEEDED") || reasons.has("REPRICE_AMOUNT_EXCEEDED")) {
      if (approvalLevelRank(level) < approvalLevelRank("MANAGER")) level = "MANAGER";
    }
  }

  const policySources = APPROVAL_KEYS.map((key) => input.policies[key]).filter(
    (value): value is ResolvedPricingValue => value !== undefined,
  );

  return ApprovalRequirement.parse({
    level,
    role: LEVEL_TO_ROLE[level],
    amountCents: input.amountCents,
    baselineAmountCents: baseline ?? null,
    ...(changeAmountCents !== undefined ? { changeAmountCents } : {}),
    changePctBps,
    escalated: level !== "SALES" || reasons.size > 0,
    reasons: [...reasons],
    policySources,
  });
}

/** 解析一次报价要用的阈值策略。 */
export async function resolveApprovalPolicies(
  pricing: PricingService,
  context: PricingContext,
): Promise<Partial<Record<PricingKey, ResolvedPricingValue>>> {
  const resolved = await pricing.resolveMany(APPROVAL_KEYS, context);
  return resolved;
}

/**
 * 审批人必须同时满足三点，否则拒绝（内核兜底，不信任前端）：
 * 1. 角色具备审批能力（白名单 OWNER / MANAGER / SALES），否则 fail-closed；
 * 2. 角色等级不低于单据要求的审批等级；
 * 3. 金额不超过成员级审批额度（未配置时回落到定价策略里的公司级阈值，即上面第 2 点）。
 */
export function assertCanApprove(
  actorRole: MemberRole | undefined,
  requirement: ApprovalRequirement,
  approvalLimitAmount?: number | null,
): void {
  // 生产态（NODE_ENV=production 或 AUTH_MODE=oidc）必须由网关注入真实角色；缺角色 fail-closed。
  // 仅本地/测试保留 OWNER 回退，方便既有 demo 与集成测试。
  const role = actorRole ?? (isProductionLike(process.env) ? undefined : "OWNER");
  if (!role) {
    throw new KernelError("PERMISSION_DENIED", "缺少审批人角色，拒绝审批");
  }
  const actual = roleApprovalLevel(role);
  if (actual === null) {
    throw new KernelError("PERMISSION_DENIED", `角色 ${role} 不具备报价审批能力，拒绝审批`);
  }
  if (approvalLevelRank(actual) < approvalLevelRank(requirement.level)) {
    throw new KernelError(
      "PERMISSION_DENIED",
      `该单据需要 ${requirement.level} 审批，当前角色 ${role} 权限不足`,
    );
  }
  if (approvalLimitAmount != null && requirement.amountCents > approvalLimitAmount) {
    throw new KernelError(
      "PERMISSION_DENIED",
      `金额 ${requirement.amountCents} 分超过成员审批额度 ${approvalLimitAmount} 分，需上级复核`,
    );
  }
}

export { roleApprovalLevel };

/**
 * 改稿能力门：只有产品矩阵里「生成报价草稿」的角色可以改账本。
 *
 * 与人审不同，这里不比较金额等级：改稿本身不限额，改到什么程度由
 * computeRequirement 的改幅/改额阈值把审批层级顶上去，再由 assertCanApprove 拦人。
 * 角色缺省时与 assertCanApprove 同一套 fail-closed 约定：
 * 生产态直接拒，本地/测试保留 OWNER 回退。
 */
export function assertCanEditQuote(actorRole: MemberRole | undefined): void {
  const role = actorRole ?? (isProductionLike(process.env) ? undefined : "OWNER");
  if (!role) {
    throw new KernelError("PERMISSION_DENIED", "缺少改稿人角色，拒绝改稿");
  }
  if (!hasQuoteEditCapability(role)) {
    throw new KernelError("PERMISSION_DENIED", `角色 ${role} 不具备报价编辑能力，拒绝改稿`);
  }
}
