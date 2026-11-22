import { randomUUID } from "node:crypto";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * 编号规则接入客户/样品主路径的验收：
 *  - 未配置 → 新编号逐字节等同改造前（C/S + 北京 YYMMDD + - + 4 位）；
 *  - 改规则 → 只影响新建，历史编号不动；显式 code 优先，规则不介入；
 *  - 显式改码仍可用且审计完整（铁律措辞收敛后的语义）。
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "code-number-entities-test", role: "OWNER" } };

let db: Db | null = null;
let available = false;
const tenantId = randomUUID();
const suffix = () => Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  db = createDb(DATABASE_URL).db;
  try {
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`SELECT to_regclass('public.code_rules') IS NOT NULL AS ok`);
    available = true;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (available && db) {
    const { sql } = await import("drizzle-orm");
    // 先删引用表再删主表（customer_contexts / customer_contacts 引用 customers）
    for (const table of [
      "customer_contexts",
      "customer_contacts",
      "customers",
      "samples",
      "code_rules",
      "code_counters",
      // audit_log 是 append-only（有 DELETE 触发器），测试审计行保留即可。
    ]) {
      await db.execute(sql.raw(`DELETE FROM ${table} WHERE tenant_id = '${tenantId}'::uuid`));
    }
  }
});

describe("编号规则接入客户/样品", () => {
  it("未配置规则：客户/样品新编号逐字节兼容现状，且序号递增", async () => {
    if (!available || !db) return;
    const kernel = createKernel(db, undefined, { tenantId });
    const c1 = await kernel.customers.createForHuman({ name: `编号-${suffix()}` }, HUMAN);
    const c2 = await kernel.customers.createForHuman({ name: `编号-${suffix()}` }, HUMAN);
    expect(c1.code).toMatch(/^C\d{6}-\d{4}$/);
    expect(c2.code).toMatch(/^C\d{6}-\d{4}$/);
    expect(Number(c2.code.slice(-4))).toBeGreaterThan(Number(c1.code.slice(-4)));
  });

  it("改规则只影响新建：历史客户编号不变，新客户用新模板", async () => {
    if (!available || !db) return;
    const kernel = createKernel(db, undefined, { tenantId });
    const before = await kernel.customers.createForHuman({ name: `历史-${suffix()}` }, HUMAN);
    await kernel.codeNumber.save(
      { entityType: "customer", template: "KH-{YYYYMM}-{SEQ:4}", presetKey: null },
      HUMAN,
    );
    const after = await kernel.customers.createForHuman({ name: `新单-${suffix()}` }, HUMAN);
    expect(before.code).toMatch(/^C\d{6}-\d{4}$/); // 历史不变
    expect(after.code).toMatch(/^KH-\d{6}-\d{4}$/); // 新单用新规则
    await kernel.codeNumber.reset("customer", HUMAN);
  });

  it("显式 code 优先：规则不介入", async () => {
    if (!available || !db) return;
    const kernel = createKernel(db, undefined, { tenantId });
    const explicit = `EXPL-${suffix()}`;
    const c = await kernel.customers.createForHuman({ code: explicit, name: "显式编号" }, HUMAN);
    expect(c.code).toBe(explicit);
  });

  it("样品编号走规则；显式改码仍可用且留审计", async () => {
    if (!available || !db) return;
    const kernel = createKernel(db, undefined, { tenantId });
    const { sql } = await import("drizzle-orm");
    // 规则接线验证：在同一租户会话里用 codeNumber 生成样品号
    const generated = await db.transaction((tx) => kernel.codeNumber.allocate(tx, "sample"));
    expect(generated).toMatch(/^S\d{6}-\d{4}$/);
    // 显式建样 + 显式改码（铁律措辞收敛后保留的纠错能力）
    const sample = await kernel.samples.create(
      { code: `S-INIT-${suffix()}`, name: "改码样品", unit: "meter" },
      HUMAN,
    );
    const newCode = `S-FIX-${suffix()}`;
    const updated = await kernel.samples.update(sample.id, { code: newCode }, HUMAN);
    expect(updated.code).toBe(newCode);
    const events = await kernel.audit.businessEvents(50, ["SAMPLE_UPDATED"]);
    expect(events.some((e) => e.entityId === sample.id)).toBe(true);
    await db.execute(sql`DELETE FROM samples WHERE id = ${sample.id}::uuid`);
  });
});
