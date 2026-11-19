import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "@weave-order/db";

/**
 * 真正的升级测试（WAN-177）：在一个临时库里先跑到 0025，写入一条只有旧三列的客户，
 * 再用 PR 头的完整迁移集升级，断言 0026 的回填把老客户变成一条主联系人。
 *
 * 为什么不能只测迁移文件里的 SQL：读路径已经切到 `customer_contacts`，
 * 回填一旦从迁移里丢失，老客户就会在界面上「没有联系人」。
 * 这里验证的是迁移执行本身，而不是测试自己抄的一段 SQL。
 */
const BASE_URL = process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const DRIZZLE_DIR = path.resolve(process.cwd(), "../../packages/db/drizzle");

function databaseUrlFor(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

describe("0026 迁移：存量联系人回填（升级）", () => {
  it("从 0025 升级到 PR 头后，老客户已有主联系人且手机号归一化保留前导 +", async (ctx) => {
    const admin = new Pool({ connectionString: BASE_URL, connectionTimeoutMillis: 1500, max: 1 });
    try {
      await admin.query("SELECT 1");
    } catch {
      await admin.end();
      ctx.skip();
      return;
    }

    const dbName = `weave_upg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const scratch = await mkdtemp(path.join(tmpdir(), "weave-mig-"));
    const baselineDir = path.join(scratch, "baseline");
    let tempPool: Pool | null = null;
    try {
      try {
        await admin.query(`CREATE DATABASE "${dbName}"`);
      } catch {
        // 没有建库权限的共享实例：跳过而不是把测试变成环境红灯。
        ctx.skip();
        return;
      }

      // 1) 基线与完整迁移目录：基线只保留 idx <= 25 的条目。
      const journalPath = path.join(DRIZZLE_DIR, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
        entries: Array<{ idx: number; tag: string }>;
      };
      for (const dir of [baselineDir, path.join(scratch, "head")]) {
        await mkdir(path.join(dir, "meta"), { recursive: true });
      }
      const baselineEntries = journal.entries.filter((entry) => entry.idx <= 25);
      await writeFile(
        path.join(baselineDir, "meta", "_journal.json"),
        JSON.stringify({ ...journal, entries: baselineEntries }, null, 2),
      );
      for (const entry of baselineEntries) {
        await copyFile(
          path.join(DRIZZLE_DIR, `${entry.tag}.sql`),
          path.join(baselineDir, `${entry.tag}.sql`),
        );
      }
      for (const entry of journal.entries) {
        await copyFile(
          path.join(DRIZZLE_DIR, `${entry.tag}.sql`),
          path.join(scratch, "head", `${entry.tag}.sql`),
        );
      }
      await copyFile(journalPath, path.join(scratch, "head", "meta", "_journal.json"));

      // 2) 基线库：只到 0025。
      const baselineHandle = createDb(databaseUrlFor(dbName));
      tempPool = baselineHandle.pool;
      await migrate(baselineHandle.db, { migrationsFolder: baselineDir });

      const tenantId = "00000000-0000-4000-8000-00000000a177";
      const customerId = "00000000-0000-4000-8000-00000000c177";
      await tempPool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [
        tenantId,
        "upgrade-legacy",
        "升级前的老公司",
      ]);
      await tempPool.query(
        `INSERT INTO customers (id, tenant_id, code, name, contact_name, contact_phone, contact_email)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          customerId,
          tenantId,
          "CT-LEGACY",
          "老客户",
          "老周",
          "+86 138 0000 1111",
          "zhou@legacy.test",
        ],
      );
      // 第二条老数据：没有 name，只有手机号，验证名称兜底与前导 + 之外的归一化。
      const fallbackCustomerId = "00000000-0000-4000-8000-00000000c178";
      await tempPool.query(
        `INSERT INTO customers (id, tenant_id, code, name, contact_phone)
           VALUES ($1, $2, $3, $4, $5)`,
        [fallbackCustomerId, tenantId, "CT-EMPTY-NAME", "只有手机号的客户", "021-5555 6666"],
      );

      // 3) 升级到 PR 头：0026 回填 + 0027 分区。
      await migrate(baselineHandle.db, { migrationsFolder: path.join(scratch, "head") });

      const contacts = await tempPool.query<{
        name: string;
        phone: string;
        phone_normalized: string;
        email: string;
        is_primary: boolean;
      }>(
        `SELECT name, phone, phone_normalized, email, is_primary
             FROM customer_contacts WHERE customer_id = $1`,
        [customerId],
      );
      expect(contacts.rows).toHaveLength(1);
      expect(contacts.rows[0]).toMatchObject({
        name: "老周",
        phone: "+86 138 0000 1111",
        phone_normalized: "+8613800001111",
        email: "zhou@legacy.test",
        is_primary: true,
      });

      // 名称缺失时兜底「主要联系人」，手机号归一化去掉分隔符。
      const fallback = await tempPool.query<{ name: string; phone_normalized: string }>(
        `SELECT name, phone_normalized FROM customer_contacts
            WHERE customer_id = $1`,
        [fallbackCustomerId],
      );
      expect(fallback.rows[0]).toEqual({ name: "主要联系人", phone_normalized: "02155556666" });
    } finally {
      await tempPool?.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end();
      await rm(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});
