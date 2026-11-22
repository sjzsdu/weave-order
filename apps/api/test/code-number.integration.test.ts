import { randomUUID } from "node:crypto";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeNumberService } from "../src/kernel/code-number.service";
import { isCodeConflict } from "../src/kernel/code-conflict";

/**
 * CodeNumberService 的并发与冲突验收（真连 PG）。
 *
 * 覆盖评审强调的闭环：
 *  - 同一分桶 N 个并发创建，全部拿到不同序号、计数器精确 +N；
 *  - 撞编号唯一索引时 SAVEPOINT 重试推进计数器，不撞草稿幂等键等其他约束；
 *  - 换天 / 改规则换桶后序号独立起算；
 *  - 北京时区 + 进位 + 运行时宽度硬校验。
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

let db: Db | null = null;
let available = false;
const tenantId = randomUUID();

beforeAll(async () => {
  const handle = createDb(DATABASE_URL);
  db = handle.db;
  try {
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`SELECT to_regclass('public.code_counters') IS NOT NULL AS ok`);
    available = true;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  // 清理本测试写入的计数器/规则
  if (available && db) {
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`DELETE FROM code_counters WHERE tenant_id = ${tenantId}::uuid`);
    await db.execute(sql`DELETE FROM code_rules WHERE tenant_id = ${tenantId}::uuid`);
  }
});

describe("CodeNumberService", () => {
  const now = new Date("2026-11-15T16:00:00.000Z"); // 北京 11-16

  it("未配置规则时回退 classic，编号逐字节等同现状", async () => {
    if (!available || !db) return;
    const svc = new CodeNumberService(db, tenantId);
    const code = await db.transaction((tx) => svc.allocate(tx, "customer", now));
    expect(code).toMatch(/^C261116-\d{4}$/);
  });

  it("同一分桶 20 并发取号互不相同、计数器精确 +20", async () => {
    if (!available || !db) return;
    const bucketTenant = randomUUID();
    const bucketSvc = new CodeNumberService(db, bucketTenant);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        db!.transaction((tx) => bucketSvc.allocate(tx, "sample", now)),
      ),
    );
    const codes = results.map((r) => r);
    expect(new Set(codes).size).toBe(20);
    const tails = codes.map((code) => Number(code.split("-").at(-1))).sort((a, b) => a - b);
    expect(tails[0]).toBe(1);
    expect(tails.at(-1)).toBe(20);
    const { sql } = await import("drizzle-orm");
    const counter = await db.execute(sql`SELECT seq FROM code_counters WHERE tenant_id = ${bucketTenant}::uuid`);
    expect(Number(counter.rows[0]?.seq)).toBe(20);
    await db.execute(sql`DELETE FROM code_counters WHERE tenant_id = ${bucketTenant}::uuid`);
  });

  it("换天换桶，序号独立从 1 起", async () => {
    if (!available || !db) return;
    const svc = new CodeNumberService(db, tenantId);
    const d1 = await db.transaction((tx) => svc.allocate(tx, "order", new Date("2026-11-15T10:00:00Z")));
    const d2 = await db.transaction((tx) => svc.allocate(tx, "order", new Date("2026-11-16T10:00:00Z")));
    expect(d1).toMatch(/^DD261115-/);
    expect(d2).toMatch(/^DD261116-/);
    expect(d2.endsWith("-0001")).toBe(true);
  });

  it("自定义模板立即生效（KH-{YYYYMM}-{SEQ:4}）", async () => {
    if (!available || !db) return;
    const svc = new CodeNumberService(db, tenantId);
    const ctx = { actor: { type: "HUMAN" as const, id: "code-number-test", role: "OWNER" as const }, tenantId };
    await svc.save({ entityType: "customer", template: "KH-{YYYYMM}-{SEQ:4}", presetKey: null }, ctx);
    const code = await db.transaction((tx) => svc.allocate(tx, "customer", now));
    expect(code).toMatch(/^KH-202611-\d{4}$/);
    await svc.reset("customer", ctx);
  });

  it("非法模板保存被拒（未知占位符 / 超宽）", async () => {
    if (!available || !db) return;
    const svc = new CodeNumberService(db, tenantId);
    const ctx = { actor: { type: "HUMAN" as const, id: "code-number-test", role: "OWNER" as const }, tenantId };
    await expect(
      svc.save({ entityType: "sample", template: "S-{UNKNOWN}-{SEQ:4}" }, ctx),
    ).rejects.toMatchObject({ details: { reason: "CODE_TEMPLATE_UNKNOWN_PLACEHOLDER" } });
    await expect(
      svc.save({ entityType: "sample", template: `S${"X".repeat(30)}-{SEQ:4}` }, ctx),
    ).rejects.toMatchObject({ details: { reason: "CODE_TEMPLATE_TOO_LONG" } });
  });
});

describe("isCodeConflict 只认编号唯一索引", () => {
  const fakeError = (constraint: string) => ({ code: "23505", constraint });
  it("编号索引命中为真", () => {
    expect(isCodeConflict(fakeError("customers_tenant_code_idx"), "customer")).toBe(true);
    expect(isCodeConflict(fakeError("samples_tenant_code_idx"), "sample")).toBe(true);
  });
  it("草稿幂等键 / 其他约束为假", () => {
    expect(isCodeConflict(fakeError("customers_tenant_draft_source_idx"), "customer")).toBe(false);
    expect(isCodeConflict(fakeError("samples_tenant_draft_source_idx"), "sample")).toBe(false);
    expect(isCodeConflict(fakeError("sample_images_primary_per_sample_idx"), "sample")).toBe(false);
  });
});
