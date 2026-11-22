import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, customers, items, quoteItems, quotes, sources } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel, isKernelError } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";
import { LocalStubEmbeddingProvider } from "../src/platform/embedding";

/**
 * P0a 领域内核落库验收（WAN-193）：需要真实 PG。
 *
 * 覆盖：
 * - 事项最小必填集 / 先查再建 / 完成必须有业务结果 / 状态机非法迁移；
 * - 客户草稿幂等、逐字段确认、草稿不进去重列表；
 * - 合并影响预览 → 确认 → 撤销窗口（引用完整回滚）；
 * - 跨租户读取按「不存在」处理。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "p0a-kernel-bootstrap" } };
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "p0a-human", role: "OWNER" } };

let pool: Pool | null = null;
let db: Db | null = null;
let available = false;
const createdTenants: string[] = [];
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 3 });
  try {
    const check = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.items') IS NOT NULL AND to_regclass('public.resource_fields') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (available) db = createDb(DATABASE_URL).db;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (pool && available && createdTenants.length > 0) {
    await pool.query("DELETE FROM resource_fields WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM sources WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM quote_items WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM quotes WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM items WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM receivables WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM sample_shipments WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM decision_deltas WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM customer_contacts WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM customer_contexts WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM customers WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM samples WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  }
  await pool?.end();
});

async function isolatedTenant(id: string) {
  if (!db) throw new Error("数据库不可用");
  const owner = createKernel(db);
  const tenant = await owner.tenancy.createTenant(
    { slug: `p0a-${id}-${suffix()}`, name: `P0a ${id}`, casdoorOrg: `p0a-${id}` },
    SYSTEM,
  );
  createdTenants.push(tenant.id);
  const kernel = createKernel(db, new LocalStubEmbeddingProvider(), { tenantId: tenant.id });
  return { tenant, kernel };
}

async function seedCustomer(kernel: Kernel, code: string, name: string) {
  return kernel.customers.create({ code, name }, HUMAN);
}

async function seedSample(kernel: Kernel, code: string, name: string) {
  return kernel.samples.create(
    { code, name, unit: "meter", costFloor: { amount: 1200, currency: "CNY" } },
    HUMAN,
  );
}

async function seedConfirmedQuote(
  database: Db,
  tenantId: string,
  customerId: string,
  sampleId: string,
  status: "DRAFT" | "SENT",
) {
  const quoteRows = await database
    .insert(quotes)
    .values({
      tenantId,
      customerId,
      status,
      currency: "CNY",
      subtotalAmount: 150000,
      totalAmount: 150000,
      validityDays: 15,
      expiresAt: new Date(Date.now() + 15 * 86400_000),
    })
    .returning();
  const quote = quoteRows[0]!;
  await database.insert(quoteItems).values({
    tenantId,
    quoteId: quote.id,
    sampleId,
    position: 1,
    description: "测试报价",
    quantityMilli: 150000,
    unit: "meter",
    unitPriceAmount: 1000,
    lineTotalAmount: 150000,
  });
  return quote;
}

describe("P0a 事项聚合根", () => {
  it("缺数量只返回待补充，库里没有 items 行", async (ctx) => {
    if (!available) ctx.skip();
    const { tenant, kernel } = await isolatedTenant("needs");
    const customer = await seedCustomer(kernel, `C-NEEDS-${suffix()}`, "缺数量客户");
    const sample = await seedSample(kernel, `S-NEEDS-${suffix()}`, "缺数量样品");

    const result = await kernel.items.create(
      { customerId: customer.id, sampleId: sample.id },
      HUMAN,
    );
    expect(result.outcome).toBe("NEEDS_INPUT");
    expect(result.item).toBeNull();
    expect(result.missingFields).toEqual(["quantity"]);

    const rows = await db!.select().from(items).where(eq(items.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });

  it("三要素齐备创建事项；重复提交命中同一事项（接续）", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("continue");
    const customer = await seedCustomer(kernel, `C-CONT-${suffix()}`, "接续客户");
    const sample = await seedSample(kernel, `S-CONT-${suffix()}`, "接续样品");
    const input = {
      customerId: customer.id,
      sampleId: sample.id,
      quantity: { value: 150, unit: "meter" as const },
    };

    const first = await kernel.items.create(input, HUMAN);
    expect(first.outcome).toBe("CREATED");
    expect(first.item?.quantityMilli).toBe(150000);

    const second = await kernel.items.create(input, HUMAN);
    expect(second.outcome).toBe("CONTINUED");
    expect(second.item?.id).toBe(first.item?.id);
    expect(second.message).toContain("接续");
  });

  it("完成必须有可观察业务结果：无报价拒绝，有已确认报价通过", async (ctx) => {
    if (!available) ctx.skip();
    const { tenant, kernel } = await isolatedTenant("complete");
    const customer = await seedCustomer(kernel, `C-COMP-${suffix()}`, "完成客户");
    const sample = await seedSample(kernel, `S-COMP-${suffix()}`, "完成样品");
    const created = await kernel.items.create(
      {
        customerId: customer.id,
        sampleId: sample.id,
        quantity: { value: 100, unit: "meter" },
      },
      HUMAN,
    );
    const itemId = created.item!.id;

    await expect(kernel.items.complete(itemId, HUMAN)).rejects.toSatisfy(
      (error: unknown) => isKernelError(error) && error.details.reason === "ITEM_RESULT_MISSING",
    );

    await seedConfirmedQuote(db!, tenant.id, customer.id, sample.id, "SENT");
    const detail = await kernel.items.complete(itemId, HUMAN);
    expect(detail.item.status).toBe("COMPLETED");
    expect(detail.allowedTransitions).toEqual([]);
  });

  it("非法状态迁移被拒绝", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("transition");
    const customer = await seedCustomer(kernel, `C-TR-${suffix()}`, "迁移客户");
    const sample = await seedSample(kernel, `S-TR-${suffix()}`, "迁移样品");
    const created = await kernel.items.create(
      {
        customerId: customer.id,
        sampleId: sample.id,
        quantity: { value: 1, unit: "meter" },
      },
      HUMAN,
    );
    const itemId = created.item!.id;

    const waiting = await kernel.items.transition(itemId, { status: "WAITING_INPUT" }, HUMAN);
    expect(waiting.item.status).toBe("WAITING_INPUT");
    // WAITING_INPUT → COMPLETED 不在状态机里：必须先回到处理中。
    await expect(kernel.items.transition(itemId, { status: "COMPLETED" }, HUMAN)).rejects.toSatisfy(
      (error: unknown) =>
        isKernelError(error) &&
        (error.details.reason === "ITEM_TRANSITION_INVALID" ||
          error.details.reason === "ITEM_RESULT_MISSING"),
    );
  });
});

describe("P0a 资源草稿与字段出处", () => {
  it("草稿按 sourceId 幂等；逐字段确认后才能确认可用", async (ctx) => {
    if (!available) ctx.skip();
    const { tenant, kernel } = await isolatedTenant("draft");
    const sourceId = randomUUID();
    await db!
      .insert(sources)
      .values({ id: sourceId, tenantId: tenant.id, kind: "TEXT", textContent: "名片原文" });

    const first = await kernel.customers.createDraft(
      { sourceId, name: "杭州草稿纺织", contactPhone: "13800001111" },
      HUMAN,
    );
    expect(first.created).toBe(true);
    expect(first.customer.status).toBe("DRAFT");
    expect(first.fields.some((field) => field.status === "PENDING")).toBe(true);

    const second = await kernel.customers.createDraft({ sourceId, name: "换了个名字" }, HUMAN);
    expect(second.created).toBe(false);
    expect(second.customer.id).toBe(first.customer.id);

    await expect(kernel.customers.confirmDraft(first.customer.id, HUMAN)).rejects.toSatisfy(
      (error: unknown) =>
        isKernelError(error) && error.details.reason === "RESOURCE_FIELDS_PENDING",
    );

    const patched = await kernel.resourceFields.updateFields(
      "customer",
      first.customer.id,
      { fields: [{ fieldName: "name", value: "杭州草稿纺织" }] },
      HUMAN,
    );
    expect(patched.find((field) => field.fieldName === "name")?.status).toBe("CONFIRMED");

    const confirmed = await kernel.customers.confirmDraft(first.customer.id, HUMAN);
    expect(confirmed.status).toBe("AVAILABLE");

    const fields = await kernel.resourceFields.list("customer", first.customer.id, "AVAILABLE");
    expect(fields.find((field) => field.fieldName === "name")?.sourceKind).toBe("bizcard");
    // 编号没有原件出处：必须显式标 manual，而不是伪装成识别结果。
    expect(fields.find((field) => field.fieldName === "code")?.sourceKind).toBe("manual");
  });

  it("草稿不进入客户列表（去重建议的取数面）", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("draft-list");
    const sourceId = randomUUID();
    const tenantId = createdTenants[createdTenants.length - 1]!;
    await db!
      .insert(sources)
      .values({ id: sourceId, tenantId, kind: "TEXT", textContent: "列表草稿原文" });
    const draft = await kernel.customers.createDraft({ sourceId, name: "列表草稿客户" }, HUMAN);
    const list = await kernel.customers.list({ limit: 200 }, HUMAN);
    expect(list.some((customer) => customer.id === draft.customer.id)).toBe(false);

    const withDrafts = await kernel.customers.list({ limit: 200, includeDrafts: true }, HUMAN);
    expect(withDrafts.some((customer) => customer.id === draft.customer.id)).toBe(true);
  });

  it("样品草稿可按 sourceId 幂等创建、逐字段确认后确认可用", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("sample-draft");
    const sourceId = randomUUID();
    const tenantId = createdTenants[createdTenants.length - 1]!;
    await db!
      .insert(sources)
      .values({ id: sourceId, tenantId, kind: "TEXT", textContent: "标签原文" });

    const draft = await kernel.samples.createDraft(
      { sourceId, name: "草稿面料", composition: "100% 棉", weight: { value: 220, unit: "gsm" } },
      HUMAN,
    );
    expect(draft.created).toBe(true);
    expect(draft.sample.status).toBe("DRAFT");
    const again = await kernel.samples.createDraft({ sourceId, name: "换个名字" }, HUMAN);
    expect(again.created).toBe(false);
    expect(again.sample.id).toBe(draft.sample.id);

    await kernel.resourceFields.updateFields(
      "sample",
      draft.sample.id,
      { fields: [{ fieldName: "name", value: "草稿面料" }] },
      HUMAN,
    );
    const confirmed = await kernel.samples.confirmDraft(draft.sample.id, HUMAN);
    expect(confirmed.status).toBe("AVAILABLE");
  });
});

describe("P0a 合并预览 → 确认 → 撤销", () => {
  it("单据迁移到目标客户，撤销窗口内完整回滚", async (ctx) => {
    if (!available) ctx.skip();
    const { tenant, kernel } = await isolatedTenant("merge");
    const source = await seedCustomer(kernel, `C-MG-${suffix()}`, "重复客户");
    const target = await seedCustomer(kernel, `C-MG-${suffix()}`, "主客户");
    const sample = await seedSample(kernel, `S-MG-${suffix()}`, "合并样品");
    const quote = await seedConfirmedQuote(db!, tenant.id, source.id, sample.id, "SENT");

    const preview = await kernel.customers.previewMerge(source.id, target.id, HUMAN);
    expect(preview.counts.quotes).toBe(1);

    const merged = await kernel.customers.merge(
      source.id,
      { targetCustomerId: target.id, previewToken: preview.previewToken },
      HUMAN,
    );
    expect(merged.moved.quotes).toBe(1);

    const movedQuote = await db!.select().from(quotes).where(eq(quotes.id, quote.id));
    expect(movedQuote[0]?.customerId).toBe(target.id);

    const sourceRows = await db!.select().from(customers).where(eq(customers.id, source.id));
    expect(sourceRows[0]?.status).toBe("ARCHIVED");

    const undone = await kernel.customers.undoMerge(
      source.id,
      { undoToken: merged.undoToken },
      HUMAN,
    );
    expect(undone.customer.status).toBe("AVAILABLE");
    const restoredQuote = await db!.select().from(quotes).where(eq(quotes.id, quote.id));
    expect(restoredQuote[0]?.customerId).toBe(source.id);
  });

  it("预览票据被篡改时拒绝合并", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("merge-token");
    const source = await seedCustomer(kernel, `C-MT-${suffix()}`, "源客户");
    const target = await seedCustomer(kernel, `C-MT-${suffix()}`, "目标客户");
    const preview = await kernel.customers.previewMerge(source.id, target.id, HUMAN);
    await expect(
      kernel.customers.merge(
        source.id,
        { targetCustomerId: target.id, previewToken: `${preview.previewToken}tampered` },
        HUMAN,
      ),
    ).rejects.toSatisfy(
      (error: unknown) => isKernelError(error) && error.details.reason === "MERGE_TOKEN_INVALID",
    );
  });
});

describe("P0a 跨租户隔离", () => {
  it("另一个租户的内核读不到事项和客户字段", async (ctx) => {
    if (!available) ctx.skip();
    const a = await isolatedTenant("iso-a");
    const b = await isolatedTenant("iso-b");
    const customer = await seedCustomer(a.kernel, `C-ISO-${suffix()}`, "租户 A 客户");
    const sample = await seedSample(a.kernel, `S-ISO-${suffix()}`, "租户 A 样品");
    const created = await a.kernel.items.create(
      {
        customerId: customer.id,
        sampleId: sample.id,
        quantity: { value: 2, unit: "meter" },
      },
      HUMAN,
    );

    await expect(b.kernel.items.getById(created.item!.id)).rejects.toSatisfy(
      (error: unknown) => isKernelError(error) && error.code === "RESOURCE_NOT_FOUND",
    );
    await expect(
      b.kernel.resourceFields.list("customer", customer.id, "AVAILABLE"),
    ).rejects.toSatisfy(
      (error: unknown) => isKernelError(error) && error.code === "CUSTOMER_NOT_FOUND",
    );
  });
});
