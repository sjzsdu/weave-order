import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ApprovalDecisionResult, ReviseQuoteDraftResult } from "@weave-order/schema";
import type { MemberRole } from "@weave-order/schema";
import { createDb } from "@weave-order/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

type DbHandle = ReturnType<typeof createDb>;

/**
 * 越权回归基座：角色矩阵 / 成员额度 / 改稿越权，走真实 HTTP 审批入口。
 *
 * 只写测试，不改业务代码。
 *
 * 判据来自产品文档 `docs/product-design.md` §3.3 权限矩阵，**硬编码在本文件里**
 * 当作独立的预言机（oracle）：绝不 import 被测的 `roleApprovalLevel`，
 * 否则实现错了测试也跟着错。当前实现只测了 SALES/MANAGER/OWNER 三种角色、
 * 且全部用例串行，这正是越权能溜过 CI 的原因。
 *
 * 与仓库既有集成测试的差别：**不允许 `ctx.skip()`** —— 没有库在 `beforeAll`
 * 直接抛出明确错误。这里的 `skipIf` 不是「跑不起来就跳过」，
 * 而是显式登记「依赖的缺陷还没修」（见 SUSPENDED_UNTIL_FIXED）。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "authz-matrix-system" } };
const AGENT: KernelContext = { actor: { type: "AGENT", id: "authz-matrix-agent" } };

/** 产品默认阈值：业务员 5 万分、主管 20 万分（approval-policy 的 SYSTEM_DEFAULTS）。 */
const SALES_LIMIT = 5_000_000;
const MANAGER_LIMIT = 20_000_000;

/** 成员额度用例：SALES 配 5000 分额度，去批 30000 分的报价必须被拒。 */
const MEMBER_LIMIT_CENTS = 5_000;
const OVER_LIMIT_QUOTE_CENTS = 30_000;

/** 未修复项的挂起开关：`main` 必须常绿，红用例回到 issue 里去红。 */
type PendingFix = "WAN-93" | "WAN-105";

/**
 * 每条挂起都在用例上方注明依赖的 issue；**对应修复合入时把开关改回 `false`**，
 * 让用例恢复常驻执行。开关只允许收敛，不允许再往里加新的跳过。
 *
 * - WAN-93：角色能力表 + 成员级额度（审批越权 / 成员超额）
 * - WAN-105：改稿越权（非报价角色改他人草稿）
 */
const SUSPENDED_UNTIL_FIXED: Record<PendingFix, boolean> = {
  "WAN-93": false,
  "WAN-105": true,
};

const ALL_ROLES: MemberRole[] = [
  "OWNER",
  "MANAGER",
  "SALES",
  "MERCHANDISER",
  "SAMPLE_ADMIN",
  "FINANCE",
  "VIEWER",
];

/** 非报价角色：按产品矩阵没有「生成/编辑报价」能力，改他人草稿必须被拒。 */
const NON_QUOTE_ROLES: MemberRole[] = ["MERCHANDISER", "SAMPLE_ADMIN", "FINANCE", "VIEWER"];

/**
 * 产品矩阵（docs/product-design.md §3.3）：
 * 批准报价 ≤5万：owner / manager / sales；≤20万：owner / manager；>20万：owner。
 * 其余角色（merchandiser / sample_admin / finance / viewer）任何金额都无审批权。
 */
function allowedRolesFor(amountCents: number): MemberRole[] {
  if (amountCents <= SALES_LIMIT) return ["OWNER", "MANAGER", "SALES"];
  if (amountCents <= MANAGER_LIMIT) return ["OWNER", "MANAGER"];
  return ["OWNER"];
}

const AMOUNT_CASES = [
  { label: "低于业务员阈值 1 分", amount: 4_999_999 },
  { label: "等于业务员阈值", amount: SALES_LIMIT },
  { label: "高于业务员阈值 1 分（需主管）", amount: SALES_LIMIT + 1 },
  { label: "等于主管阈值", amount: MANAGER_LIMIT },
  { label: "高于主管阈值 1 分（需老板）", amount: MANAGER_LIMIT + 1 },
];

/** [角色, 金额, 金额说明, 按产品矩阵应有的结论] */
type MatrixRow = {
  role: MemberRole;
  amount: number;
  label: string;
  verdict: "允许" | "拒绝";
  /** 非空 = 该行依赖的缺陷未修复，挂起不执行（见 SUSPENDED_UNTIL_FIXED）。 */
  pending: PendingFix | null;
};

/**
 * 当前实现里必红的 10 行归 WAN-93：`roleApprovalLevel` 把
 * merchandiser / sample_admin / viewer 当成 SALES、把 finance 当成 MANAGER，
 * 于是「当前等级 ≥ 产品矩阵要求的等级」的角色会被误放行（越权审批）。
 * 这个判定只用来标记哪几行现在必红，不参与断言；
 * WAN-93 落地后连同 pending 一起删除即可恢复全量常驻。
 */
const LEVEL_RANK = { SALES: 1, MANAGER: 2, OWNER: 3 } as const;
type ApprovalLevelName = keyof typeof LEVEL_RANK;

function requiredLevelFor(amountCents: number): ApprovalLevelName {
  if (amountCents <= SALES_LIMIT) return "SALES";
  if (amountCents <= MANAGER_LIMIT) return "MANAGER";
  return "OWNER";
}

function currentLevelFor(role: MemberRole): ApprovalLevelName {
  if (role === "OWNER") return "OWNER";
  if (role === "MANAGER" || role === "FINANCE") return "MANAGER";
  return "SALES";
}

function pendingFor(
  role: MemberRole,
  amountCents: number,
  verdict: "允许" | "拒绝",
): PendingFix | null {
  if (verdict !== "拒绝") return null;
  const wronglyAllowed =
    LEVEL_RANK[currentLevelFor(role)] >= LEVEL_RANK[requiredLevelFor(amountCents)];
  return wronglyAllowed ? "WAN-93" : null;
}

const MATRIX: MatrixRow[] = ALL_ROLES.flatMap((role) =>
  AMOUNT_CASES.map((entry) => {
    const verdict = allowedRolesFor(entry.amount).includes(role) ? "允许" : "拒绝";
    return {
      role,
      amount: entry.amount,
      label: entry.label,
      verdict,
      pending: pendingFor(role, entry.amount, verdict),
    };
  }),
);

const ACTIVE_MATRIX = MATRIX.filter((row) => row.pending === null);
const SUSPENDED_MATRIX = MATRIX.filter((row) => row.pending !== null);

interface World {
  baseUrl: string;
  org: string;
  /** 绑定测试租户的内核（owner 连接），用于造数。 */
  kernel: Kernel;
  customerId: string;
  sampleId: string;
  subjects: Map<string, string>;
}

let handle: DbHandle | null = null;
let app: INestApplication | null = null;
let world: World | null = null;

beforeAll(async () => {
  const created = createDb(DATABASE_URL);
  try {
    const probe = await created.pool.query<{ memberships: boolean; quotes: boolean }>(
      `SELECT to_regclass('public.memberships') IS NOT NULL AS memberships,
              to_regclass('public.quotes') IS NOT NULL AS quotes`,
    );
    if (probe.rows[0]?.memberships !== true || probe.rows[0]?.quotes !== true) {
      throw new Error("缺少 memberships / quotes 表，迁移尚未执行");
    }
  } catch (error) {
    await created.pool.end();
    throw new Error(
      `[越权回归] 需要 PostgreSQL（${DATABASE_URL}）才能运行，但探测失败：${
        error instanceof Error ? error.message : String(error)
      }。本用例禁止静默跳过（不允许 ctx.skip()）——请先 docker compose up -d && pnpm db:migrate。`,
    );
  }
  handle = created;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const server = app.getHttpServer() as Server;
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const org = `authz-${tag}`;
  const ownerKernel = createKernel(created.db);
  const tenant = await ownerKernel.tenancy.createTenant(
    { slug: `authz-${tag}`, name: "越权矩阵租户", casdoorOrg: org },
    SYSTEM,
  );

  const subjects = new Map<string, string>();
  for (const role of ALL_ROLES) {
    const subject = `${role.toLowerCase()}-${tag}`;
    subjects.set(role, subject);
    await ownerKernel.tenancy.createMembership(
      { tenantId: tenant.id, subject, casdoorOrg: org, role, dataScope: "ALL" },
      SYSTEM,
    );
  }
  // 成员额度用例：另一个 SALES，配置了 5000 分的个人审批额度。
  const limitedSubject = `sales-limited-${tag}`;
  subjects.set("SALES_LIMITED", limitedSubject);
  await ownerKernel.tenancy.createMembership(
    {
      tenantId: tenant.id,
      subject: limitedSubject,
      casdoorOrg: org,
      role: "SALES",
      dataScope: "OWN",
      approvalLimitAmount: MEMBER_LIMIT_CENTS,
    },
    SYSTEM,
  );

  const kernel = createKernel(created.db, undefined, { tenantId: tenant.id });
  const customer = await kernel.customers.create(
    { code: `AZ-C-${tag}`, name: "越权矩阵客户" },
    SYSTEM,
  );
  const sample = await kernel.samples.create(
    {
      code: `AZ-S-${tag}`,
      name: "越权矩阵面料",
      unit: "meter",
      costFloor: { amount: 1000, currency: "CNY" },
    },
    SYSTEM,
  );

  world = { baseUrl, org, kernel, customerId: customer.id, sampleId: sample.id, subjects };
}, 60_000);

afterAll(async () => {
  await app?.close();
  await handle?.pool.end();
  handle = null;
  world = null;
});

function requireWorld(): World {
  if (!world) {
    throw new Error("[越权回归] 前置失败：PostgreSQL / HTTP 服务未就绪，本用例不静默跳过");
  }
  return world;
}

function token(scope: World, key: string): string {
  const subject = scope.subjects.get(key);
  if (!subject) throw new Error(`未登记的成员身份：${key}`);
  return `Bearer dev:${subject}:${scope.org}`;
}

interface DecisionOutcome {
  httpStatus: number;
  ok: boolean;
  code?: string;
  status?: string;
  detail: string;
}

/** 走真实审批入口 POST /api/approvals/decide。 */
async function decide(scope: World, roleKey: string, quoteId: string): Promise<DecisionOutcome> {
  const response = await fetch(`${scope.baseUrl}/api/approvals/decide`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token(scope, roleKey),
    },
    body: JSON.stringify({ id: quoteId, kind: "quote", decision: "APPROVE" }),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = null;
  }
  const parsed = ApprovalDecisionResult.safeParse(body);
  if (parsed.success) {
    if (parsed.data.ok) {
      return {
        httpStatus: response.status,
        ok: true,
        status: parsed.data.data.status,
        detail: text,
      };
    }
    return {
      httpStatus: response.status,
      ok: false,
      code: parsed.data.error.code,
      detail: parsed.data.error.message,
    };
  }
  return { httpStatus: response.status, ok: false, code: `HTTP_${response.status}`, detail: text };
}

/** 被拒必须是「授权拒绝」，而不是别的错误碰巧挡住了。 */
function deniedByAuthz(outcome: DecisionOutcome): boolean {
  return (
    !outcome.ok &&
    (outcome.code === "PERMISSION_DENIED" ||
      outcome.httpStatus === 401 ||
      outcome.httpStatus === 403)
  );
}

interface ReviseOutcome {
  httpStatus: number;
  ok: boolean;
  code?: string;
  detail: string;
}

/** 人类改稿入口 POST /api/quotes/revise。 */
async function revise(
  scope: World,
  roleKey: string,
  quoteId: string,
  baseVersion: number,
): Promise<ReviseOutcome> {
  const response = await fetch(`${scope.baseUrl}/api/quotes/revise`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token(scope, roleKey),
    },
    body: JSON.stringify({
      quoteId,
      baseVersion,
      source: "INLINE",
      instruction: "把单价改到 8888 分",
      lines: [{ lineIndex: 0, unitPrice: { amount: 8888, currency: "CNY" } }],
    }),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = null;
  }
  const parsed = ReviseQuoteDraftResult.safeParse(body);
  if (parsed.success) {
    if (parsed.data.ok) return { httpStatus: response.status, ok: true, detail: "改稿成功" };
    return {
      httpStatus: response.status,
      ok: false,
      code: parsed.data.error.code,
      detail: parsed.data.error.message,
    };
  }
  return { httpStatus: response.status, ok: false, code: `HTTP_${response.status}`, detail: text };
}

/** 造一张金额精确等于 amountCents 的草稿（1 米 × amountCents 分/米）。 */
async function newDraft(scope: World, amountCents: number): Promise<string> {
  const draft = await scope.kernel.quotes.generateDraft(
    {
      customerId: scope.customerId,
      currency: "CNY",
      items: [
        {
          fabricSampleId: scope.sampleId,
          quantity: { value: 1, unit: "meter" },
          unitPrice: { amount: amountCents, currency: "CNY" },
        },
      ],
    },
    AGENT,
  );
  if (draft.total.amount !== amountCents) {
    throw new Error(
      `测试造数失败：期望草稿总额 ${amountCents} 分，内核算出 ${draft.total.amount} 分，矩阵金额不可信`,
    );
  }
  return draft.id;
}

async function assertMatrixRow(row: MatrixRow): Promise<void> {
  const { role, amount, label, verdict } = row;
  const scope = requireWorld();
  const quoteId = await newDraft(scope, amount);
  const outcome = await decide(scope, role, quoteId);
  const context = `角色 ${role} 批准 ${amount} 分报价（${label}）：回执 ${JSON.stringify(outcome)}`;

  if (verdict === "允许") {
    expect(
      outcome.ok,
      `${context} —— 按 docs/product-design.md §3.3，该角色在该金额段有审批权，却被拒绝`,
    ).toBe(true);
    expect(outcome.status, `${context} —— 批准成功后草稿必须落为 SENT`).toBe("SENT");
    return;
  }

  expect(
    outcome.ok,
    `${context} —— 角色 ${role} 按产品矩阵没有这个金额段的审批权，却批准成功（越权审批）`,
  ).toBe(false);
  expect(
    deniedByAuthz(outcome),
    `${context} —— 拒绝必须是权限拒绝（PERMISSION_DENIED / 401 / 403），不能是别的错误碰巧挡住`,
  ).toBe(true);
}

const MATRIX_TITLE = "审批矩阵：$role 报价 $amount 分（$label）→ 按产品矩阵应$verdict";

describe("角色越权矩阵（7 角色 × 阈值金额，真实 HTTP 审批入口）", () => {
  // 常驻：三角色正向矩阵 + 阈值以上/以下的已有正确拒绝，当前全绿。
  it.each(ACTIVE_MATRIX)(MATRIX_TITLE, assertMatrixRow, 30_000);

  // 挂起：依赖 WAN-93（角色能力表；当前实现给非报价角色留了业务员/主管级审批权）。
  describe.skipIf(SUSPENDED_UNTIL_FIXED["WAN-93"])(
    "【挂起】越权审批行（WAN-93：角色能力表）",
    () => {
      it.each(SUSPENDED_MATRIX)(MATRIX_TITLE, assertMatrixRow, 30_000);
    },
  );
});

/**
 * 成员额度要真正生效，需要两环：WAN-93 在 `HumanActorService` 注入
 * `ctx.actor.approvalLimitAmount`，以及 `quotes.service` 的
 * confirmDraft / rejectDraft 调 `assertCanApprove` 时把它传进去——后者归 S2-1 / WAN-96
 * （WAN-93 的边界写明不碰 quotes.service.ts）。少任何一环，超额用例都会一直红，
 * 所以超额那条先挂起（依赖 WAN-93），回落对照常驻。
 */
describe("成员级审批额度（memberships.approval_limit_amount）", () => {
  // 挂起：依赖 WAN-93。
  it.skipIf(SUSPENDED_UNTIL_FIXED["WAN-93"])(
    `SALES 配置 ${MEMBER_LIMIT_CENTS} 分额度 → 批准 ${OVER_LIMIT_QUOTE_CENTS} 分报价必须被拒`,
    async () => {
      const scope = requireWorld();
      const quoteId = await newDraft(scope, OVER_LIMIT_QUOTE_CENTS);
      const outcome = await decide(scope, "SALES_LIMITED", quoteId);
      const context = `成员额度 ${MEMBER_LIMIT_CENTS} 分的 SALES 批准 ${OVER_LIMIT_QUOTE_CENTS} 分报价：回执 ${JSON.stringify(outcome)}`;

      expect(
        outcome.ok,
        `${context} —— 成员个人额度落库、设置页也展示，但审批时没有参与判定，超额度的报价被放行了`,
      ).toBe(false);
      expect(deniedByAuthz(outcome), `${context} —— 超额度必须是权限拒绝`).toBe(true);
    },
    30_000,
  );

  it(`SALES 未配置额度 → 回落公司阈值，批准 ${OVER_LIMIT_QUOTE_CENTS} 分报价应当成功`, async () => {
    const scope = requireWorld();
    const quoteId = await newDraft(scope, OVER_LIMIT_QUOTE_CENTS);
    const outcome = await decide(scope, "SALES", quoteId);
    const context = `未配置额度的 SALES 批准 ${OVER_LIMIT_QUOTE_CENTS} 分报价：回执 ${JSON.stringify(outcome)}`;

    expect(outcome.ok, `${context} —— 未配置成员额度时应回落公司级阈值（业务员 5 万分）`).toBe(
      true,
    );
    expect(outcome.status, `${context} —— 批准成功后草稿必须落为 SENT`).toBe("SENT");
  }, 30_000);
});

/**
 * 改稿越权：`quotes.service.reviseDraft` 目前只有 actor.type === HUMAN 一道闸，
 * 没有任何角色能力校验。该缺口已有 issue 认领：WAN-105，4 条拒绝用例随它挂起，
 * 正向对照（SALES 改自己的草稿）常驻。
 */
describe("改稿越权（非报价角色改他人草稿）", () => {
  // 挂起：依赖 WAN-105。
  describe.skipIf(SUSPENDED_UNTIL_FIXED["WAN-105"])(
    "【挂起】非报价角色改他人草稿（WAN-105）",
    () => {
      it.each(NON_QUOTE_ROLES)(
        "改稿越权：%s 改他人（SALES）的草稿必须被拒",
        async (role) => {
          const scope = requireWorld();
          const quoteId = await newDraft(scope, 30_000);
          const outcome = await revise(scope, role, quoteId, 1);
          const context = `角色 ${role} 修改 SALES 名下的报价草稿：回执 ${JSON.stringify(outcome)}`;

          expect(
            outcome.ok,
            `${context} —— 该角色没有报价编辑能力（产品矩阵 §3.3），却把别人的草稿改掉了`,
          ).toBe(false);
          const authzDenied =
            outcome.code === "PERMISSION_DENIED" ||
            outcome.httpStatus === 401 ||
            outcome.httpStatus === 403;
          expect(authzDenied, `${context} —— 拒绝必须是权限拒绝，而不是其他错误`).toBe(true);
        },
        30_000,
      );
    },
  );

  it("正向对照：报价角色（SALES）改自己的草稿仍然成功，证明上面的拒绝是角色专属性", async () => {
    const scope = requireWorld();
    const quoteId = await newDraft(scope, 30_000);
    const outcome = await revise(scope, "SALES", quoteId, 1);
    const context = `角色 SALES 修改自己的报价草稿：回执 ${JSON.stringify(outcome)}`;

    expect(outcome.ok, `${context} —— 报价角色改自己的草稿必须可用，否则是把功能改死了`).toBe(true);
  }, 30_000);
});
