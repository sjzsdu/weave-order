import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/kernel";
import type { Kernel } from "../src/kernel";

/**
 * 开张进度集成测试（真实 PostgreSQL）：验证「换设备一致」依赖的落库与合并规则。
 *
 * 没有本地 PG 时整组跳过，`pnpm test` 离线仍全绿；CI 带 postgres 服务会真正执行。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

let pool: Pool | null = null;
let kernel: Kernel | null = null;
let available = false;
let tenantId = "";
const memberId = "onboarding-it-member";

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const probe = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.onboarding_state') IS NOT NULL AS exists",
    );
    available = probe.rows[0]?.exists === true;
  } catch {
    available = false;
  }
  if (!available) return;
  // 每个用例文件一个独立租户，互不干扰；租户 id 只用于隔离，不需要真实 tenants 行。
  tenantId = `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`;
  const db: Db = createDb(DATABASE_URL).db;
  kernel = createKernel(db, undefined, { tenantId });
});

afterAll(async () => {
  if (pool && available) {
    await pool.query("DELETE FROM onboarding_state WHERE tenant_id = $1", [tenantId]);
  }
  await pool?.end();
});

describe("开张进度持久化", () => {
  it("没有记录时返回默认态（不是报错）", async () => {
    if (!available || !kernel) return;
    const state = await kernel.onboardingState.get(memberId);
    expect(state).toEqual({
      completedAt: {},
      collapsed: false,
      skipped: false,
      allDoneAt: null,
      updatedAt: null,
    });
  });

  it("首次完成时间只记一次，重复上报不覆盖", async () => {
    if (!available || !kernel) return;
    const first = await kernel.onboardingState.update(memberId, { completeSteps: ["customer"] });
    expect(first.completedAt.customer).toBeTruthy();
    const stamp = first.completedAt.customer;

    const second = await kernel.onboardingState.update(memberId, { completeSteps: ["customer"] });
    expect(second.completedAt.customer).toBe(stamp);
  });

  it("四步齐全才写 allDoneAt，收起/跳过与完成进度互不覆盖", async () => {
    if (!available || !kernel) return;
    const partial = await kernel.onboardingState.update(memberId, {
      completeSteps: ["sample", "quote"],
    });
    expect(partial.allDoneAt).toBeNull();

    const collapsed = await kernel.onboardingState.update(memberId, { collapsed: true });
    expect(collapsed.collapsed).toBe(true);
    expect(Object.keys(collapsed.completedAt).sort()).toEqual(["customer", "quote", "sample"]);

    const done = await kernel.onboardingState.update(memberId, { completeSteps: ["approve"] });
    expect(done.allDoneAt).toBeTruthy();
    expect(done.collapsed).toBe(true);

    const skipped = await kernel.onboardingState.update(memberId, { skipped: true });
    expect(skipped.skipped).toBe(true);
    expect(skipped.allDoneAt).toBe(done.allDoneAt);
  });

  it("换设备 = 另一个连接读同一行，进度与时间一致", async () => {
    if (!available || !kernel || !pool) return;
    const { rows } = await pool.query<{ member_id: string; skipped: boolean; all_done_at: Date }>(
      "SELECT member_id, skipped, all_done_at FROM onboarding_state WHERE tenant_id = $1 AND member_id = $2",
      [tenantId, memberId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.skipped).toBe(true);

    const reread = await kernel.onboardingState.get(memberId);
    expect(reread.allDoneAt).toBeTruthy();
    expect(reread.skipped).toBe(true);
  });

  it("非法输入被契约拒绝（客户端不能自报时间戳）", async () => {
    if (!available || !kernel) return;
    await expect(
      kernel.onboardingState.update(memberId, {
        completedAt: { customer: "2026-11-16T10:00:00.000Z" },
      }),
    ).rejects.toThrow();
  });
});
