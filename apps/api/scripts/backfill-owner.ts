/**
 * 历史客户归属回填（WAN-106，方案 A）。
 *
 * 用法：
 *   pnpm db:backfill-owner                 # 只读体检：打印每个租户的待回填条数 / 目标负责人 / 回滚语句
 *   pnpm db:backfill-owner -- --apply      # 单事务执行回填
 *   pnpm db:backfill-owner -- --tenant=<uuid> [--apply]   # 只处理指定租户（运维/测试）
 *
 * 规则（只有这一条）：
 *   `customers.owner_id IS NULL` → 该租户**最早创建的 ACTIVE OWNER 成员**（memberships.id）。
 *
 * 取舍（对比方案 B「无归属数据对 OWNER/MANAGER 可见」）：
 *  - A 改数据不改可见性判定：`OWN` + `owner_id IS NULL` 仍然 fail-closed，
 *    WAN-99 的权限语义一行不放宽；代价是必须跑一次回填。
 *  - 无 ACTIVE OWNER 的租户不会被猜归属：报告里列出并跳过，--apply 后仍以非 0 退出提示人工处理。
 *  - 只回填 customers：quotes / samples / receivables / shipments 的归属都随客户，
 *    客户归属补齐后它们一并恢复可见（见 data-scope.ts 的判定口径）。
 */
import path from "node:path";
import { Pool } from "pg";
import { loadEnv } from "../src/platform/env";

try {
  process.loadEnvFile(path.resolve(__dirname, "../../../.env"));
} catch {
  // 没有 .env 就用默认值
}

export interface BackfillPlan {
  tenantId: string;
  tenantSlug: string;
  /** 目标负责人 = 租户最早的 ACTIVE OWNER 成员；为空表示该租户无法自动回填。 */
  ownerMembershipId: string | null;
  /** ACTIVE OWNER 候选数量；>1 时报告里提示，仍选最早创建的一个。 */
  ownerCandidates: number;
  customerIds: string[];
}

interface PendingRow {
  tenant_id: string;
  slug: string;
  id: string;
}

/** 只读：列出待回填客户并解析目标负责人。传 `tenantIds` 可限定范围（测试用）。 */
export async function planOwnerBackfill(
  pool: Pool,
  tenantIds?: readonly string[],
): Promise<BackfillPlan[]> {
  const scope = tenantIds && tenantIds.length > 0;
  const pending = await pool.query<PendingRow>(
    `SELECT c.tenant_id, t.slug, c.id
       FROM customers c
       JOIN tenants t ON t.id = c.tenant_id
      WHERE c.owner_id IS NULL ${scope ? "AND c.tenant_id = ANY($1::uuid[])" : ""}
      ORDER BY c.tenant_id, c.created_at, c.id`,
    scope ? [tenantIds] : [],
  );

  const byTenant = new Map<string, { slug: string; ids: string[] }>();
  for (const row of pending.rows) {
    const entry = byTenant.get(row.tenant_id) ?? { slug: row.slug, ids: [] };
    entry.ids.push(row.id);
    byTenant.set(row.tenant_id, entry);
  }

  const plans: BackfillPlan[] = [];
  for (const [tenantId, entry] of byTenant) {
    const owners = await pool.query<{ id: string }>(
      `SELECT id FROM memberships
        WHERE tenant_id = $1 AND role = 'OWNER' AND status = 'ACTIVE'
        ORDER BY created_at, id`,
      [tenantId],
    );
    plans.push({
      tenantId,
      tenantSlug: entry.slug,
      ownerMembershipId: owners.rows[0]?.id ?? null,
      ownerCandidates: owners.rows.length,
      customerIds: entry.ids,
    });
  }
  return plans.sort((a, b) => a.tenantSlug.localeCompare(b.tenantSlug));
}

/**
 * 单事务执行回填。返回实际更新条数与事务时间戳（回滚匹配条件）。
 * 任何一步失败整体回滚，不会出现「一半归 Owner、一半还是 NULL」。
 */
export async function applyOwnerBackfill(
  pool: Pool,
  plans: readonly BackfillPlan[],
): Promise<{ updated: number; appliedAt: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const timestamp = await client.query<{ at: Date }>("SELECT now() AS at");
    const appliedAt = (timestamp.rows[0]?.at ?? new Date()).toISOString();

    let updated = 0;
    for (const plan of plans) {
      if (!plan.ownerMembershipId || plan.customerIds.length === 0) continue;
      const result = await client.query(
        `UPDATE customers
            SET owner_id = $1, updated_at = now()
          WHERE id = ANY($2::uuid[]) AND owner_id IS NULL`,
        [plan.ownerMembershipId, plan.customerIds],
      );
      updated += result.rowCount ?? 0;
    }

    await client.query("COMMIT");
    return { updated, appliedAt };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 回滚语句：小批量逐 id 精确恢复；大批量按「租户 + 负责人 + 事务时间戳」匹配。 */
export function rollbackSql(plan: BackfillPlan, appliedAt: string): string {
  if (!plan.ownerMembershipId) return "-- 该租户未回填，无需回滚";
  if (plan.customerIds.length <= 100) {
    const ids = plan.customerIds.map((id) => `'${id}'`).join(", ");
    return `UPDATE customers SET owner_id = NULL, updated_at = now() WHERE id IN (${ids});`;
  }
  return (
    `-- ${plan.customerIds.length} 行：按租户 + 负责人 + 本次事务时间戳匹配回滚\n` +
    `UPDATE customers SET owner_id = NULL, updated_at = now()\n` +
    ` WHERE tenant_id = '${plan.tenantId}' AND owner_id = '${plan.ownerMembershipId}'\n` +
    `   AND updated_at >= '${appliedAt}';`
  );
}

function renderPlan(plan: BackfillPlan, appliedAt: string): string[] {
  const lines: string[] = [];
  const head = `租户 ${plan.tenantSlug} (${plan.tenantId})：${plan.customerIds.length} 条无归属客户`;
  if (!plan.ownerMembershipId) {
    lines.push(`  ✖ ${head} → 无 ACTIVE OWNER 成员，跳过（需人工指定负责人）`);
    return lines;
  }
  const multiple = plan.ownerCandidates > 1 ? `，候选 ${plan.ownerCandidates} 个取最早创建` : "";
  lines.push(`  · ${head} → OWNER 成员 ${plan.ownerMembershipId}${multiple}`);
  for (const line of rollbackSql(plan, appliedAt).split("\n")) {
    lines.push(`    回滚：${line}`);
  }
  return lines;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantArg = process.argv.find((arg) => arg.startsWith("--tenant="));
  const tenantIds = tenantArg ? [tenantArg.slice("--tenant=".length)] : undefined;

  const env = loadEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    const tableCheck = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.customers') IS NOT NULL AND to_regclass('public.memberships') IS NOT NULL AS exists",
    );
    if (!tableCheck.rows[0]?.exists) {
      throw new Error("数据库表不存在，请先运行：pnpm db:migrate");
    }

    const plans = await planOwnerBackfill(pool, tenantIds);
    const total = plans.reduce((sum, plan) => sum + plan.customerIds.length, 0);
    console.log(
      `\n客户归属回填（方案 A）：owner_id IS NULL → 租户最早的 ACTIVE OWNER 成员\n` +
        `模式：${apply ? "APPLY（单事务写库）" : "只读（未写库；加 --apply 执行）"}\n`,
    );

    if (plans.length === 0) {
      console.log("✔ 没有需要回填的客户");
      return;
    }

    let appliedAt = new Date().toISOString();
    let updated = 0;
    if (apply) {
      ({ updated, appliedAt } = await applyOwnerBackfill(pool, plans));
      console.log(`✔ 已回填 ${updated} 条（单事务提交）\n`);
    }

    for (const plan of plans) {
      for (const line of renderPlan(plan, appliedAt)) console.log(line);
    }

    const blocked = plans.filter((plan) => !plan.ownerMembershipId);
    console.log(
      `\n合计：${total} 条待回填 / ${plans.length} 个租户 / ${blocked.length} 个租户无法自动回填` +
        (apply ? `，本次更新 ${updated} 条` : "（只读）"),
    );
    if (blocked.length > 0) {
      console.log("✖ 存在无 ACTIVE OWNER 的租户，请先补成员或手工指定负责人");
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// 测试会 import 本模块，只有直接执行时才跑 CLI。
if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error("\n✖ 回填失败：", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
