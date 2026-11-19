import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { AuditLogService } from "../src/kernel/audit-log.service";
import type { KernelContext } from "../src/kernel/audit";
import type { ObjectBytes, ObjectHead, ObjectStorage } from "../src/platform/storage";

/**
 * 操作日志读取 / 导出集成测试：需要本地 PostgreSQL（docker compose up -d postgres）。
 * 没有数据库时整组跳过，纯离线 CI 仍然全绿。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

let probe: Pool | null = null;
let available = false;
let db: Db | null = null;
const tenantId = randomUUID();
const otherTenantId = randomUUID();

const OWNER: KernelContext = { actor: { type: "HUMAN", id: "owner-1", role: "OWNER" } };
const SALES: KernelContext = { actor: { type: "HUMAN", id: "sales-1", role: "SALES" } };

/** 内存对象存储：只验证「导出写了什么」，不发真实网络请求。 */
class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();

  presignPut(): Promise<string> {
    return Promise.resolve("memory://put");
  }
  signGet(key: string): Promise<string> {
    return Promise.resolve(`memory://${key}`);
  }
  head(): Promise<ObjectHead | null> {
    return Promise.resolve(null);
  }
  put(key: string, bytes: Buffer): Promise<void> {
    this.objects.set(key, bytes);
    return Promise.resolve();
  }
  get(key: string): Promise<ObjectBytes | null> {
    const bytes = this.objects.get(key);
    return Promise.resolve(bytes ? { contentType: "text/csv", bytes } : null);
  }
  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}

const storage = new MemoryStorage();

beforeAll(async () => {
  probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    await probe.query("SELECT to_regclass('public.audit_log') IS NOT NULL AS exists");
    db = createDb(DATABASE_URL).db;
    available = true;
  } catch {
    available = false;
  } finally {
    await probe.end();
    probe = null;
  }
  if (!available || !db) return;

  await db.insert(auditLog).values([
    {
      tenantId,
      actorType: "HUMAN",
      actorId: "sales-1",
      actorRole: "SALES",
      actorName: "周敏",
      action: "QUOTE_DRAFT_REVISED",
      entityType: "quote",
      entityId: randomUUID(),
      entityLabel: "Q-2026-001",
      before: { unitPriceAmount: 1500, costFloorAmount: 1200 },
      after: { unitPriceAmount: 1450, costFloorAmount: 1200 },
      createdAt: new Date("2026-11-18T02:00:00Z"),
    },
    {
      tenantId,
      actorType: "HUMAN",
      actorId: "owner-1",
      actorRole: "OWNER",
      actorName: "老板",
      action: "QUOTE_CONFIRMED",
      entityType: "quote",
      entityId: randomUUID(),
      entityLabel: "Q-2026-002",
      before: null,
      after: { totalAmount: 900000 },
      createdAt: new Date("2026-11-18T03:00:00Z"),
    },
    {
      tenantId,
      actorType: "AGENT",
      actorId: "agent:xiao-zhi",
      actorName: null,
      action: "QUOTE_DRAFT_GENERATED",
      entityType: "quote",
      entityId: randomUUID(),
      entityLabel: "Q-2026-003",
      createdAt: new Date("2026-11-19T01:00:00Z"),
    },
    {
      tenantId: otherTenantId,
      actorType: "HUMAN",
      actorId: "sales-1",
      actorRole: "SALES",
      action: "CUSTOMER_CREATED",
      entityType: "customer",
      entityId: randomUUID(),
      entityLabel: "别的公司",
      createdAt: new Date("2026-11-19T01:30:00Z"),
    },
  ] as never);
});

afterAll(async () => {
  if (db) {
    // 审计表是 append-only（触发器拒绝 DELETE）。测试库允许临时关触发器清理自建数据，
    // 否则每次跑测试都会给共享库留垃圾；线上不会执行这段代码。
    const { pool } = createDb(DATABASE_URL);
    try {
      await pool.query("ALTER TABLE audit_log DISABLE TRIGGER weave_audit_log_no_delete");
      await pool.query("DELETE FROM audit_log WHERE tenant_id = ANY($1)", [
        [tenantId, otherTenantId],
      ]);
      await pool.query("ALTER TABLE audit_log ENABLE TRIGGER weave_audit_log_no_delete");
      await pool.query("DELETE FROM audit_export_jobs WHERE tenant_id = ANY($1)", [
        [tenantId, otherTenantId],
      ]);
    } finally {
      await pool.end();
    }
  }
});

describe("操作日志读取", () => {
  it("OWNER 看全公司，且只返回本租户", async (ctx) => {
    if (!available) ctx.skip();
    const service = new AuditLogService(db as Db, tenantId, storage);
    const result = await service.list({ limit: 50 }, OWNER);
    expect(result.scope).toBe("ALL");
    expect(result.items).toHaveLength(3);
    expect(result.items.map((item) => item.entityLabel)).not.toContain("别的公司");
    expect(result.items.map((item) => item.action)).toContain("QUOTE_CONFIRMED");
  });

  it("SALES 只能看到自己的操作（服务端强制 actor_id）", async (ctx) => {
    if (!available) ctx.skip();
    const service = new AuditLogService(db as Db, tenantId, storage);
    const result = await service.list({ limit: 50 }, SALES);
    expect(result.scope).toBe("OWN");
    expect(result.items.every((item) => item.actorId === "sales-1")).toBe(true);
    expect(result.items).toHaveLength(1);
  });

  it("keyset 游标不重复也不跳过", async (ctx) => {
    if (!available) ctx.skip();
    const service = new AuditLogService(db as Db, tenantId, storage);
    const first = await service.list({ limit: 2 }, OWNER);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list({ limit: 2, cursor: first.nextCursor ?? undefined }, OWNER);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const seqs = [...first.items, ...second.items].map((item) => item.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("筛选：动作、高风险、关键词、时间范围", async (ctx) => {
    if (!available) ctx.skip();
    const service = new AuditLogService(db as Db, tenantId, storage);
    expect((await service.list({ actions: ["QUOTE_CONFIRMED"] }, OWNER)).items).toHaveLength(1);
    const highRisk = await service.list({ highRisk: true }, OWNER);
    expect(highRisk.items.every((item) => item.highRisk)).toBe(true);
    expect(highRisk.items.map((item) => item.action)).toContain("QUOTE_CONFIRMED");
    expect((await service.list({ keyword: "批准" }, OWNER)).items).toHaveLength(1);
    expect(
      (
        await service.list(
          { from: new Date("2026-11-19T00:00:00Z"), to: new Date("2026-11-19T23:59:59Z") },
          OWNER,
        )
      ).items,
    ).toHaveLength(1);
  });
});

describe("详情与敏感字段裁剪", () => {
  it("SALES 看自己的报价改稿：成本价被裁剪，单价保留", async (ctx) => {
    if (!available) ctx.skip();
    const service = new AuditLogService(db as Db, tenantId, storage);
    const list = await service.list({ actions: ["QUOTE_DRAFT_REVISED"] }, SALES);
    const detail = await service.detail(list.items[0]!.seq, SALES);
    expect(detail.before).toMatchObject({ unitPriceAmount: 1500, costFloorAmount: "价格已修改" });
    expect(detail.maskedFields).toContain("costFloorAmount");
  });

  it("OWNER 有成本能力，看到原值", async (ctx) => {
    if (!available) ctx.skip();
    const service = new AuditLogService(db as Db, tenantId, storage);
    const list = await service.list({ actions: ["QUOTE_DRAFT_REVISED"] }, OWNER);
    const detail = await service.detail(list.items[0]!.seq, OWNER);
    expect(detail.before).toMatchObject({ costFloorAmount: 1200 });
    expect(detail.maskedFields).toEqual([]);
  });

  it("SALES 打开别人的记录与不存在一样返回 404 语义", async (ctx) => {
    if (!available) ctx.skip();
    const service = new AuditLogService(db as Db, tenantId, storage);
    const list = await service.list({ actions: ["QUOTE_CONFIRMED"] }, OWNER);
    await expect(service.detail(list.items[0]!.seq, SALES)).rejects.toThrow(/没有找到序号为/);
  });
});

describe("摘要", () => {
  it("按天分组（北京时间）并统计高风险与操作者类型", async (ctx) => {
    if (!available) ctx.skip();
    const service = new AuditLogService(db as Db, tenantId, storage);
    const summary = await service.summary("30d", OWNER);
    expect(summary.scope).toBe("ALL");
    expect(summary.total).toBe(3);
    expect(summary.highRiskCount).toBe(2);
    expect(summary.days.map((day) => day.date).sort()).toEqual(["2026-11-18", "2026-11-19"]);
    expect(summary.actorTypes.find((row) => row.actorType === "AGENT")?.count).toBe(1);
  });
});

describe("异步导出", () => {
  it("SALES 可导出，但范围跟随审计范围：只含自己的记录", async (ctx) => {
    if (!available) ctx.skip();
    const service = new AuditLogService(db as Db, tenantId, storage);
    const job = await service.createExport({}, SALES);
    await service.runExport(job.id);

    const done = await service.exportJob(job.id, SALES);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.rowCount).toBe(1);
    const csv = storage.objects
      .get(`tenant/${tenantId}/audit-exports/${job.id}.csv`)
      ?.toString("utf8");
    expect(csv).toContain("Q-2026-001");
    expect(csv).not.toContain("Q-2026-002");
  });

  it("OWNER 导出：CSV 落对象存储，只写一条 AUDIT_EXPORTED", async (ctx) => {
    if (!available) ctx.skip();
    const service = new AuditLogService(db as Db, tenantId, storage);
    const job = await service.createExport({}, OWNER);
    await service.runExport(job.id);

    const done = await service.exportJob(job.id, OWNER);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.rowCount).toBe(4);
    expect(done.downloadUrl).toMatch(/^memory:\/\//);

    const stored = storage.objects.get(`tenant/${tenantId}/audit-exports/${job.id}.csv`);
    expect(stored?.toString("utf8")).toContain("时间（北京时间）");
    expect(stored?.toString("utf8")).toContain("Q-2026-001");

    const exportedRows = await (db as Db)
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "AUDIT_EXPORTED"));
    expect(exportedRows.length).toBeGreaterThanOrEqual(1);
    expect(exportedRows.some((row) => row.entityLabel === "全公司操作日志")).toBe(true);
    expect(exportedRows.some((row) => row.entityLabel === "我的操作日志")).toBe(true);
  });
});
