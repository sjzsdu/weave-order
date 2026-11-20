import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTenantSession } from "@weave-order/db";

/**
 * P0a 契约冻结（WAN-191）的物理验收：四张新表在真实 PG 上可用。
 *
 * 只验证「迁移 + RLS + 索引 + 默认值」这一层，不碰内核：
 * - weave_app 在两个租户会话里只能看到自己的行（新表已进 RLS 名单）；
 * - 字段出处矩阵的唯一键是 tenant + resourceType + resourceId + fieldName；
 * - 存量客户的 `status` 默认落 `AVAILABLE`（存量行由列默认值直接变可用）。
 */

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const APP_URL =
  process.env.APP_DATABASE_URL ?? "postgres://weave_app:weave_app@localhost:5433/weave_order";

let ownerPool: Pool | null = null;
let appPool: Pool | null = null;
let available = false;

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const SOURCE_A = randomUUID();
const CUSTOMER_A = randomUUID();

beforeAll(async () => {
  ownerPool = new Pool({ connectionString: OWNER_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const probe = await ownerPool.query<{ exists: boolean }>(
      `SELECT to_regclass('public.items') IS NOT NULL
          AND to_regclass('public.sources') IS NOT NULL
          AND to_regclass('public.resource_fields') IS NOT NULL
          AND to_regclass('public.ocr_results') IS NOT NULL
          AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='weave_app') AS exists`,
    );
    available = probe.rows[0]?.exists === true;
    if (available)
      appPool = new Pool({ connectionString: APP_URL, connectionTimeoutMillis: 1500, max: 2 });
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (ownerPool && available) {
    await ownerPool.query("DELETE FROM resource_fields WHERE tenant_id = ANY($1::uuid[])", [
      [TENANT_A, TENANT_B],
    ]);
    await ownerPool.query("DELETE FROM ocr_results WHERE tenant_id = ANY($1::uuid[])", [
      [TENANT_A, TENANT_B],
    ]);
    await ownerPool.query("DELETE FROM items WHERE tenant_id = ANY($1::uuid[])", [
      [TENANT_A, TENANT_B],
    ]);
    await ownerPool.query("DELETE FROM sources WHERE tenant_id = ANY($1::uuid[])", [
      [TENANT_A, TENANT_B],
    ]);
    await ownerPool.query("DELETE FROM customers WHERE tenant_id = ANY($1::uuid[])", [
      [TENANT_A, TENANT_B],
    ]);
  }
  await ownerPool?.end();
  await appPool?.end();
});

describe("P0a 新表（真连 PG）", () => {
  it("weave_app 在两个租户会话里只能看到自己的行", async () => {
    if (!available || !appPool || !ownerPool) return;
    await ownerPool.query(
      `INSERT INTO sources (id, tenant_id, kind, object_key, mime_type, byte_size)
       VALUES ($1, $2, 'IMAGE', 'tenant/a/uploads/a.jpg', 'image/jpeg', 1024)`,
      [SOURCE_A, TENANT_A],
    );

    const sessionA = await openTenantSession(appPool, TENANT_A);
    const sessionB = await openTenantSession(appPool, TENANT_B);
    try {
      const seenA = await sessionA.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM sources`,
      );
      const seenB = await sessionB.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM sources`,
      );
      expect(seenA.rows[0]?.n).toBe(1);
      expect(seenB.rows[0]?.n).toBe(0);
    } finally {
      await sessionA.release();
      await sessionB.release();
    }
  });

  it("字段出处矩阵的唯一键挡住同字段第二行", async () => {
    if (!appPool) return;
    const session = await openTenantSession(appPool, TENANT_A);
    const insert = () =>
      session.db.execute(sql`
        INSERT INTO resource_fields
          (tenant_id, resource_type, resource_id, field_name, value, status, source_id, source_kind)
        VALUES
          (${TENANT_A}, 'customer', ${CUSTOMER_A}, 'name', '"杭州青织"'::jsonb, 'PENDING', ${SOURCE_A}, 'bizcard')
      `);
    try {
      await insert();
      // drizzle 会把 PG 错误包一层 DrizzleQueryError，23505 在 cause 链上。
      let code: string | undefined;
      try {
        await insert();
      } catch (error) {
        let current: unknown = error;
        for (let depth = 0; depth < 5 && current; depth += 1) {
          const candidate = (current as { code?: unknown }).code;
          if (typeof candidate === "string") {
            code = candidate;
            break;
          }
          current = (current as { cause?: unknown }).cause;
        }
      }
      expect(code).toBe("23505");
    } finally {
      await session.release();
    }
  });

  it("存量客户加列后直接落 AVAILABLE，OCR 失败行保留机器可读原因", async () => {
    if (!ownerPool) return;
    await ownerPool.query(
      "INSERT INTO customers (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)",
      [CUSTOMER_A, TENANT_A, "C-P0A-1", "存量客户"],
    );
    const customer = await ownerPool.query<{ status: string }>(
      "SELECT status FROM customers WHERE id = $1",
      [CUSTOMER_A],
    );
    expect(customer.rows[0]?.status).toBe("AVAILABLE");

    await ownerPool.query(
      `INSERT INTO ocr_results (tenant_id, source_id, engine, status, failure_code, attempts)
       VALUES ($1, $2, 'multimodal:test@1', 'FAILED', 'LOW_CONFIDENCE', 2)`,
      [TENANT_A, SOURCE_A],
    );
    const ocr = await ownerPool.query<{ failure_code: string; attempts: number }>(
      "SELECT failure_code, attempts FROM ocr_results WHERE tenant_id = $1",
      [TENANT_A],
    );
    expect(ocr.rows[0]).toEqual({ failure_code: "LOW_CONFIDENCE", attempts: 2 });
  });
});
