import { and, eq, inArray, like } from "drizzle-orm";
import { auditLog, createDb, DEFAULT_TENANT_ID, fieldOptions, samples } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldOptionsService, seedFieldOptions } from "../src/kernel/field-options.service";
import type { KernelContext } from "../src/kernel";

/**
 * 字段选项集成测试：真实 PostgreSQL，验证改名不写历史、合并回写、软删除可恢复、
 * 并发同名复用与审计落库。没有本地 PG 时整组跳过。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "field-options-it", role: "OWNER" } };
const VIEWER: KernelContext = {
  actor: { type: "HUMAN", id: "field-options-viewer", role: "VIEWER" },
};

let pool: Pool | null = null;
let db: Db | null = null;
let service: FieldOptionsService | null = null;
let available = false;
const createdSampleCodes: string[] = [];
const suffix = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const table = await probe.query<{ exists: boolean }>(
      "SELECT to_regclass('public.field_options') IS NOT NULL AS exists",
    );
    available = table.rows[0]?.exists === true;
  } catch {
    available = false;
  } finally {
    await probe.end();
  }
  if (available) {
    const handle = createDb(DATABASE_URL);
    db = handle.db;
    pool = handle.pool;
    service = new FieldOptionsService(handle.db, DEFAULT_TENANT_ID);
    // 预置项幂等补种，保证测试不依赖迁移在何时跑过。
    await seedFieldOptions(handle.db, DEFAULT_TENANT_ID);
  }
});

afterAll(async () => {
  if (available && db) {
    try {
      // 只清本次测试造出来的行：标签带时间后缀，样品编号逐条记录。
      if (createdSampleCodes.length > 0) {
        await db
          .delete(samples)
          .where(
            and(eq(samples.tenantId, DEFAULT_TENANT_ID), inArray(samples.code, createdSampleCodes)),
          );
      }
      await db
        .delete(fieldOptions)
        .where(
          and(
            eq(fieldOptions.tenantId, DEFAULT_TENANT_ID),
            inArray(fieldOptions.fieldKey, [
              "sample.category",
              "sample.composition",
              "customer.tier",
              "contact.role",
            ]),
            like(fieldOptions.label, "%-%"),
          ),
        );
    } catch {
      // 清理失败不影响验收结论；测试数据使用唯一后缀，不会污染下一次运行。
    }
  }
  await pool?.end();
});

describe("field options kernel", () => {
  it("创建同名选项幂等复用同一行（并发防重）", async () => {
    if (!available || !service) return;
    const label = `测试品类-${suffix()}`;
    const first = await service.create({ fieldKey: "sample.category", label }, HUMAN);
    const second = await service.create(
      { fieldKey: "sample.category", label: ` ${label} ` },
      HUMAN,
    );
    expect(second.id).toBe(first.id);
    // 大小写/全角差异归一化后也复用同一行。
    const latin = `TestFabric${suffix()}`;
    const a = await service.create({ fieldKey: "sample.composition", label: latin }, HUMAN);
    const b = await service.create(
      { fieldKey: "sample.composition", label: `${latin.toUpperCase()}\u3000` },
      HUMAN,
    );
    expect(b.id).toBe(a.id);
  });

  it("改名只改 label：品类历史原文不变，等级历史自动显示新名", async () => {
    if (!available || !service || !db) return;
    const category = await service.create(
      { fieldKey: "sample.category", label: `旧品类-${suffix()}` },
      HUMAN,
    );
    const sampleCode = `M-${suffix()}`;
    createdSampleCodes.push(sampleCode);
    await db.execute(
      `insert into samples (tenant_id, code, name, category) values ('${DEFAULT_TENANT_ID}', '${sampleCode}', '改名测试样品', '${category.label}')`,
    );
    await service.rename(category.id, { label: `新品类-${suffix()}` }, HUMAN);
    const rows = await db
      .select({ category: samples.category })
      .from(samples)
      .where(and(eq(samples.tenantId, DEFAULT_TENANT_ID), eq(samples.code, sampleCode)));
    // 纯文本字段：改名不回写历史。
    expect(rows[0]?.category).toBe(category.label);

    const tier = await service.create(
      { fieldKey: "customer.tier", label: `测试等级-${suffix()}` },
      HUMAN,
    );
    await service.rename(tier.id, { label: `改名等级-${suffix()}` }, HUMAN);
    const resolved = await service.resolve("customer.tier", tier.code, true);
    expect(resolved.matched).toBe(true);
    expect(resolved.label).toContain("改名等级-");
  });

  it("合并预览给条数与样例，确认后一次事务改写并写审计", async () => {
    if (!available || !service || !db) return;
    const source = await service.create(
      { fieldKey: "sample.category", label: `源品类-${suffix()}` },
      HUMAN,
    );
    const target = await service.create(
      { fieldKey: "sample.category", label: `目标品类-${suffix()}` },
      HUMAN,
    );
    const code = `M-${suffix()}`;
    createdSampleCodes.push(code);
    await db.execute(
      `insert into samples (tenant_id, code, name, category) values ('${DEFAULT_TENANT_ID}', '${code}', '合并测试样品', '${source.label}')`,
    );

    const preview = await service.previewMerge(source.id, target.id);
    expect(preview.affected).toBeGreaterThanOrEqual(1);
    expect(preview.samples.length).toBeGreaterThanOrEqual(1);

    const result = await service.merge(
      { sourceId: source.id, targetId: target.id, rewriteText: true },
      HUMAN,
    );
    expect(result.affected).toBeGreaterThanOrEqual(1);
    const rows = await db
      .select({ category: samples.category })
      .from(samples)
      .where(and(eq(samples.tenantId, DEFAULT_TENANT_ID), eq(samples.code, code)));
    expect(rows[0]?.category).toBe(target.label);

    const merged = await service.list("sample.category", true);
    expect(merged.find((option) => option.id === source.id)?.active).toBe(false);

    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, DEFAULT_TENANT_ID), eq(auditLog.entityId, source.id)));
    expect(audits.map((row) => row.action)).toContain("FIELD_OPTION_MERGED");
  });

  it("删除是软删除且可恢复；停用项仍可解析历史值", async () => {
    if (!available || !service) return;
    const option = await service.create(
      { fieldKey: "sample.composition", label: `待删成分-${suffix()}` },
      HUMAN,
    );
    await service.remove(option.id, HUMAN);
    const hidden = await service.list("sample.composition", false);
    expect(hidden.some((item) => item.id === option.id)).toBe(false);
    // 历史值仍能解析到 label，不会显示原始 code。
    const resolved = await service.resolve("sample.composition", option.label, true);
    expect(resolved.matched).toBe(true);
    expect(resolved.label).toBe(option.label);

    await service.restore(option.id, HUMAN);
    const visible = await service.list("sample.composition", false);
    expect(visible.some((item) => item.id === option.id)).toBe(true);
  });

  it("排序要求全量且写入后顺序稳定", async () => {
    if (!available || !service) return;
    const options = await service.list("contact.role", true);
    if (options.length < 2) return;
    const reversed = [...options].reverse().map((option) => option.id);
    await service.reorder({ fieldKey: "contact.role", ids: reversed }, HUMAN);
    const after = await service.list("contact.role", true);
    expect(after.map((option) => option.id)).toEqual(reversed);
    await expect(
      service.reorder({ fieldKey: "contact.role", ids: reversed.slice(1) }, HUMAN),
    ).rejects.toThrow(/排序/);
  });

  it("任意角色都能管理选项（VIEWER 也可），未登录角色被拒", async () => {
    if (!available || !service) return;
    const created = await service.create(
      { fieldKey: "sample.category", label: `VIEWER-${suffix()}` },
      VIEWER,
    );
    expect(created.active).toBe(true);
    await expect(
      service.create(
        { fieldKey: "sample.category", label: `匿名-${suffix()}` },
        {
          actor: { type: "HUMAN", id: "no-role" },
        },
      ),
    ).rejects.toThrow(/不能管理字段选项/);
  });

  it("合并后重跑幂等（源已停用、存量行已改写）", async () => {
    if (!available || !service) return;
    const source = await service.create(
      { fieldKey: "sample.category", label: `幂等源-${suffix()}` },
      HUMAN,
    );
    const target = await service.create(
      { fieldKey: "sample.category", label: `幂等目标-${suffix()}` },
      HUMAN,
    );
    const first = await service.merge(
      { sourceId: source.id, targetId: target.id, rewriteText: true },
      HUMAN,
    );
    const second = await service.merge(
      { sourceId: source.id, targetId: target.id, rewriteText: true },
      HUMAN,
    );
    expect(first.affected).toBe(0);
    expect(second.affected).toBe(0);
  });
});

describe("field option presets", () => {
  it("每个租户都有四个字段的预置项", async () => {
    if (!available || !db) return;
    const rows = await db
      .select({ fieldKey: fieldOptions.fieldKey, code: fieldOptions.code })
      .from(fieldOptions)
      .where(eq(fieldOptions.tenantId, DEFAULT_TENANT_ID));
    const keys = new Set(rows.map((row) => row.fieldKey));
    expect(keys.has("customer.tier")).toBe(true);
    expect(keys.has("sample.category")).toBe(true);
    expect(keys.has("sample.composition")).toBe(true);
    expect(keys.has("contact.role")).toBe(true);
    // 自定义等级 code 以 T- 开头，预置 code 沿用旧枚举。
    const tierCodes = rows.filter((row) => row.fieldKey === "customer.tier").map((row) => row.code);
    expect(tierCodes).toEqual(expect.arrayContaining(["NEW", "REGULAR", "VIP", "COLD"]));
  });
});
