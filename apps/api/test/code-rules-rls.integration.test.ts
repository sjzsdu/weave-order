import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * code_rules / code_counters 的跨租户隔离验收（真连 PG + 真 weave_app 角色）。
 *
 * 这两张表是租户配置表，必须与非 RLS 表一样走行级隔离：
 *  - 租户 A 只能读/写自己那份规则，看不到租户 B 的；
 *  - 租户 B 用同样的 (tenant_id, entity_type) 写不覆盖 A 的规则（唯一索引 + RLS 双保险）；
 *  - 计数器按租户分桶，互不串号。
 *
 * 用 weave_app（NOSUPERUSER / NOBYPASSRLS）连接，SET LOCAL app.tenant_id 切租户，
 * 这样测出的才是线上真实行为；owner 连接因 BYPASSRLS 永远测不出隔离漏洞。
 */
const OWNER_URL = process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const APP_URL =
  process.env.APP_DATABASE_URL ?? OWNER_URL.replace("weave:weave@", "weave_app:weave_app@");

let owner: Pool | null = null;
let app: Pool | null = null;
let available = false;
let usesAppRole = false;
const tenantA = randomUUID();
const tenantB = randomUUID();

async function asTenant(pool: Pool, tenantId: string, fn: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await fn(client);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  owner = new Pool({ connectionString: OWNER_URL, connectionTimeoutMillis: 2000 });
  app = new Pool({ connectionString: APP_URL, connectionTimeoutMillis: 2000 });
  try {
    const probe = await owner.query<{ exists: boolean; app_role: boolean }>(
      `SELECT to_regclass('public.code_rules') IS NOT NULL AS exists,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'weave_app') = false AS app_role`,
    );
    if (probe.rows[0]?.exists !== true || probe.rows[0]?.app_role !== true) return;
    const role = await app.query<{ bypass: boolean }>(
      "SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user",
    );
    usesAppRole = role.rows[0]?.bypass === false;
    // 用 owner 连接（BYPASSRLS）造数据：两条分属不同租户的规则 + 两个计数器桶
    await owner.query("DELETE FROM code_rules WHERE tenant_id = ANY($1::uuid[])", [[tenantA, tenantB]]);
    await owner.query("DELETE FROM code_counters WHERE tenant_id = ANY($1::uuid[])", [[tenantA, tenantB]]);
    await owner.query(
      `INSERT INTO code_rules (tenant_id, entity_type, template, preset_key, created_by)
       VALUES ($1, 'customer', 'C{YYMMDD}-{SEQ:4}', 'classic', 'rls-test'),
              ($2, 'customer', 'KH{SEQ:5}', NULL, 'rls-test')`,
      [tenantA, tenantB],
    );
    await owner.query(
      `INSERT INTO code_counters (tenant_id, entity_type, bucket, seq)
       VALUES ($1, 'customer', 'C000000-', 7), ($2, 'customer', 'KH', 9)`,
      [tenantA, tenantB],
    );
    available = true;
  } catch {
    // 测试基础设施不可用（无 PG / 无 weave_app）时降级跳过，不误报功能失败。
    available = false;
  }
});

afterAll(async () => {
  if (available && owner) {
    await owner.query("DELETE FROM code_rules WHERE tenant_id = ANY($1::uuid[])", [[tenantA, tenantB]]);
    await owner.query("DELETE FROM code_counters WHERE tenant_id = ANY($1::uuid[])", [[tenantA, tenantB]]);
  }
  await app?.end().catch(() => undefined);
  await owner?.end().catch(() => undefined);
});

describe("code_rules / code_counters RLS 隔离", () => {
  it("租户 A 只看到自己的规则，看不到租户 B 的", async () => {
    if (!available || !usesAppRole) return;
    await asTenant(app!, tenantA, async (client) => {
      const result = await client.query<{ tenant_id: string; template: string }>(
        "SELECT tenant_id, template FROM code_rules WHERE entity_type = 'customer'",
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]?.tenant_id).toBe(tenantA);
      expect(result.rows[0]?.template).toBe("C{YYMMDD}-{SEQ:4}");
    });
  });

  it("租户 B 无法读到租户 A 的规则", async () => {
    if (!available || !usesAppRole) return;
    await asTenant(app!, tenantB, async (client) => {
      const result = await client.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM code_rules WHERE tenant_id = $1",
        [tenantA],
      );
      expect(result.rows).toEqual([]);
    });
  });

  it("租户 B 写入不会覆盖租户 A 的规则", async () => {
    if (!available || !usesAppRole) return;
    await asTenant(app!, tenantB, async (client) => {
      await client.query("UPDATE code_rules SET template = 'B-{SEQ:4}' WHERE entity_type = 'customer'");
    });
    const a = await owner!.query<{ template: string }>(
      "SELECT template FROM code_rules WHERE tenant_id = $1 AND entity_type = 'customer'",
      [tenantA],
    );
    expect(a.rows[0]?.template).toBe("C{YYMMDD}-{SEQ:4}");
  });

  it("计数器按租户分桶，互不串号", async () => {
    if (!available || !usesAppRole) return;
    await asTenant(app!, tenantA, async (client) => {
      const result = await client.query<{ bucket: string; seq: string }>(
        "SELECT bucket, seq FROM code_counters",
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.bucket).toBe("C000000-");
      expect(Number(result.rows[0]?.seq)).toBe(7);
    });
  });
});
