import { Pool } from "pg";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, sampleEmbeddings, samples, tenants } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel, errorChainMessage } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

/**
 * 内核集成测试：需要本地 PostgreSQL（docker compose up -d && pnpm db:migrate）。
 * 没有数据库时整组跳过，`pnpm test` 在纯离线环境仍然全绿。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "integration-human" } };
const AGENT: KernelContext = { actor: { type: "AGENT", id: "integration-agent" } };
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "kernel-it-bootstrap" } };

let probe: Pool | null = null;
let available = false;
let db: Db | null = null;
const createdTenantIds: string[] = [];

beforeAll(async () => {
  probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const table = await probe.query<{ exists: boolean }>(
      "SELECT to_regclass('public.customer_contexts') IS NOT NULL AS exists",
    );
    available = table.rows[0]?.exists === true;
    if (available) db = createDb(DATABASE_URL).db;
  } catch {
    available = false;
  } finally {
    await probe.end();
    probe = null;
  }
});

afterAll(async () => {
  if (db && createdTenantIds.length > 0) {
    // 只清理本文件自建的租户数据，避免给共享库留垃圾
    await db.delete(sampleEmbeddings).where(inArray(sampleEmbeddings.tenantId, createdTenantIds));
    await db.delete(samples).where(inArray(samples.tenantId, createdTenantIds));
    // audit_log 是 append-only（DELETE 被触发器拒绝），不清理；行数随测试增长是预期行为。
    await db.delete(tenants).where(inArray(tenants.id, createdTenantIds));
  }
  await probe?.end();
});

function kernelOf(): Kernel {
  if (!db) throw new Error("数据库不可用");
  return createKernel(db);
}

/**
 * 每个用例独立租户：以图搜图 / 参数找样的结果集只由本用例自己决定，
 * 不受并行测试文件往默认租户里写样品的影响（WAN-107）。
 */
async function isolatedKernel(id: string): Promise<Kernel> {
  if (!db) throw new Error("数据库不可用");
  const owner = createKernel(db);
  const tenant = await owner.tenancy.createTenant(
    { slug: `it-search-${id}`, name: `Kernel IT ${id}`, casdoorOrg: `it-search-${id}` },
    SYSTEM,
  );
  createdTenantIds.push(tenant.id);
  return createKernel(db, undefined, { tenantId: tenant.id });
}

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

describe("确定性内核（集成）", () => {
  it("建客户：业务表与审计日志在同一事务写入", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const code = `IT-CUST-${suffix()}`;
    const customer = await kernel.customers.create({ code, name: "集成测试客户" }, HUMAN);

    const context = await kernel.customers.getContext(customer.id);
    expect(context.customerId).toBe(customer.id);
    expect(context.decisionDeltas).toEqual([]);

    const audit = await kernel.audit.list(5, customer.id);
    const record = audit.find(
      (row) => row.action === "CUSTOMER_CREATED" && row.entityId === customer.id,
    );
    expect(record).toBeDefined();
    expect(record?.actorType).toBe("HUMAN");
    expect(record?.after).toMatchObject({ code, name: "集成测试客户" });
  }, 20_000);

  it("客户编号重复：内核返回 KERNEL_REJECTED / CUSTOMER_CODE_EXISTS", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const code = `IT-DUP-${suffix()}`;
    await kernel.customers.create({ code, name: "第一次" }, HUMAN);
    await expect(kernel.customers.create({ code, name: "第二次" }, HUMAN)).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "CUSTOMER_CODE_EXISTS" },
    });
  }, 20_000);

  it("寄样单：智能体只能建 DRAFT，确认必须人类（铁律 #2）", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const id = suffix();
    const customer = await kernel.customers.create(
      { code: `IT-SHIP-C-${id}`, name: "寄样测试客户" },
      HUMAN,
    );
    const sample = await kernel.samples.create(
      { code: `IT-SHIP-S-${id}`, name: "测试面料", unit: "meter" },
      HUMAN,
    );

    const draft = await kernel.shipments.createDraft(
      {
        customerId: customer.id,
        items: [{ sampleId: sample.id, quantity: { value: 2.5, unit: "meter" } }],
      },
      AGENT,
    );
    expect(draft.status).toBe("DRAFT");
    expect(draft.items[0]?.quantity.value).toBe(2.5);

    await expect(kernel.shipments.confirm(draft.id, AGENT)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });

    const confirmed = await kernel.shipments.confirm(draft.id, HUMAN);
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.confirmedBy).toBe(HUMAN.actor.id);

    await expect(kernel.shipments.confirm(draft.id, HUMAN)).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "INVALID_STATE_TRANSITION" },
    });
  }, 20_000);

  it("报价：金额由内核整数计算，低于成本底线被拒", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const id = suffix();
    const customer = await kernel.customers.create(
      { code: `IT-Q-C-${id}`, name: "报价测试客户" },
      HUMAN,
    );
    const sample = await kernel.samples.create(
      {
        code: `IT-Q-S-${id}`,
        name: "报价面料",
        unit: "meter",
        costFloor: { amount: 1200, currency: "CNY" },
      },
      HUMAN,
    );

    const draft = await kernel.quotes.generateDraft(
      {
        customerId: customer.id,
        currency: "CNY",
        items: [
          {
            fabricSampleId: sample.id,
            quantity: { value: 120.5, unit: "meter" },
            unitPrice: { amount: 1500, currency: "CNY" },
          },
        ],
      },
      AGENT,
    );
    expect(draft.status).toBe("DRAFT");
    expect(draft.amountsComputedByKernel).toBe(true);
    expect(draft.items[0]?.lineTotal.amount).toBe(180750);
    expect(draft.total.amount).toBe(180750);

    await expect(
      kernel.quotes.generateDraft(
        {
          customerId: customer.id,
          currency: "CNY",
          items: [
            {
              fabricSampleId: sample.id,
              quantity: { value: 10, unit: "meter" },
              unitPrice: { amount: 800, currency: "CNY" },
            },
          ],
        },
        AGENT,
      ),
    ).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "PRICE_BELOW_COST_FLOOR" },
    });

    await expect(kernel.quotes.confirmDraft(draft.id, AGENT)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  }, 20_000);

  it("找样 T-002：样品创建即建索引，参数匹配说明命中字段", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const id = suffix();
    const cotton = await kernel.samples.create(
      {
        code: `IT-SEARCH-C-${id}`,
        name: "高支棉测试面料",
        composition: "100% 棉",
        weight: "220g/m2",
        unit: "meter",
      },
      HUMAN,
    );
    await kernel.samples.create(
      {
        code: `IT-SEARCH-P-${id}`,
        name: "涤纶测试面料",
        composition: "100% polyester",
        unit: "meter",
      },
      HUMAN,
    );

    const bySpec = await kernel.search.searchBySpec({
      query: "高支棉测试面料",
      composition: "棉",
      limit: 10,
    });
    const hit = bySpec.matches.find((match) => match.sample.id === cotton.id);
    expect(hit).toBeDefined();
    expect(hit?.matchedOn).toContain("name");
    expect(hit?.score).toBeGreaterThan(0);
    expect(bySpec.matches.every((match) => match.sample.composition?.includes("棉"))).toBe(true);
  }, 20_000);

  it("找样 T-001：以图搜图在隔离数据集内返回确定性、降序且契约内的相似度", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = await isolatedKernel(suffix());
    const image = { mimeType: "image/jpeg", base64: "aGVsbG8td2VhdmU=" };

    // 自建样品：结果集完全由本用例决定，不再与并行测试共享默认租户（WAN-107）。
    const ownSampleIds = new Set<string>();
    const createBatch = async (batch: string, count: number) => {
      for (let index = 0; index < count; index += 1) {
        const sample = await kernel.samples.create(
          {
            code: `IT-IMG-${batch}-${index}`,
            name: `以图搜图样品 ${batch}-${index}`,
            composition: index % 2 === 0 ? "100% 棉" : "100% polyester",
            weight: `${200 + index}g/m2`,
            unit: "meter",
          },
          HUMAN,
        );
        ownSampleIds.add(sample.id);
      }
    };

    // 断言只看契约不变量：不锁浮点精确值、不锁具体排名。
    const assertContract = (
      result: Awaited<ReturnType<typeof kernel.search.searchByImage>>,
    ): string[] => {
      expect(result.embeddingModel).toBe("local-stub-v1");
      expect(result.dimension).toBe(16);
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.length).toBeLessThanOrEqual(5);
      // 隔离租户里只可能有本用例创建的样品
      for (const match of result.matches) {
        expect(ownSampleIds.has(match.sample.id)).toBe(true);
        expect(match.score).toBeGreaterThanOrEqual(0);
        expect(match.score).toBeLessThanOrEqual(1);
      }
      const scores = result.matches.map((match) => match.score);
      expect(scores).toEqual([...scores].sort((left, right) => right - left));
      return result.matches.map((match) => `${match.sample.id}:${match.score}`);
    };

    await createBatch("a", 8);
    const first = await kernel.search.searchByImage(image, 5, 0);
    const firstSignature = assertContract(first);

    // 同租户、同一张图：两次调用必须完全一致（确定性）。
    const second = await kernel.search.searchByImage(image, 5, 0);
    expect(second.matches.map((match) => `${match.sample.id}:${match.score}`)).toEqual(
      firstSignature,
    );

    // 样品数量翻倍后，同一组断言仍然成立。
    await createBatch("b", 8);
    const doubledFirst = await kernel.search.searchByImage(image, 5, 0);
    assertContract(doubledFirst);
    const doubledSecond = await kernel.search.searchByImage(image, 5, 0);
    expect(doubledSecond.matches.map((match) => `${match.sample.id}:${match.score}`)).toEqual(
      doubledFirst.matches.map((match) => `${match.sample.id}:${match.score}`),
    );
  }, 30_000);

  it("报价：bigint 金额可以承载超过 int4 的单笔大单", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const id = suffix();
    const customer = await kernel.customers.create(
      { code: `IT-BIG-C-${id}`, name: "大单客户" },
      HUMAN,
    );
    const sample = await kernel.samples.create(
      {
        code: `IT-BIG-S-${id}`,
        name: "大单面料",
        unit: "meter",
        costFloor: { amount: 1200, currency: "CNY" },
      },
      HUMAN,
    );

    const draft = await kernel.quotes.generateDraft(
      {
        customerId: customer.id,
        currency: "CNY",
        items: [
          {
            fabricSampleId: sample.id,
            quantity: { value: 10, unit: "meter" },
            // 3000 万/米 × 10 米 = 3 亿分（300 万元），旧 int4 列会溢出
            unitPrice: { amount: 3_000_000_000, currency: "CNY" },
          },
        ],
      },
      AGENT,
    );
    expect(draft.total.amount).toBe(30_000_000_000);
    const reloaded = await kernel.quotes.getDraft(draft.id);
    expect(reloaded.total.amount).toBe(30_000_000_000);
  }, 20_000);

  it("找样 T-002 回归：LIKE 元字符按字面量匹配，matchedOn 与 SQL 语义一致", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const id = suffix();
    const percent = await kernel.samples.create(
      { code: `IT-LIKE-P-${id}`, name: "100%棉找样回归布", unit: "meter" },
      HUMAN,
    );
    const decoy = await kernel.samples.create(
      { code: `IT-LIKE-D-${id}`, name: "100 棉找样回归布", unit: "meter" },
      HUMAN,
    );
    const underscore = await kernel.samples.create(
      { code: `IT-LIKE-U-${id}`, name: "underscore_找样回归布", unit: "meter" },
      HUMAN,
    );
    const percentCode = await kernel.samples.create(
      { code: `SMP%REG-${id}`, name: "百分号编号回归布", unit: "meter" },
      HUMAN,
    );
    const plainCode = await kernel.samples.create(
      { code: `SMP-REG-${id}`, name: "普通编号回归布", unit: "meter" },
      HUMAN,
    );

    const fieldValue = (
      match: {
        sample: { code: string; name: string; composition: string | null; weight: string | null };
      },
      field: "code" | "name" | "composition" | "weight",
    ): string => {
      if (field === "code") return match.sample.code;
      if (field === "name") return match.sample.name;
      if (field === "composition") return match.sample.composition ?? "";
      return match.sample.weight ?? "";
    };

    const queries = ["100%棉", "_", "SMP%"];
    for (const query of queries) {
      const result = await kernel.search.searchBySpec({ query, limit: 100 });
      for (const match of result.matches) {
        // 任何返回行都必须有非空 matchedOn，且每个命中字段确实字面包含关键词。
        expect(match.matchedOn.length).toBeGreaterThan(0);
        for (const field of match.matchedOn) {
          expect(fieldValue(match, field).toLowerCase()).toContain(query.toLowerCase());
        }
      }
    }

    const byPercent = await kernel.search.searchBySpec({ query: "100%棉", limit: 100 });
    const percentIds = byPercent.matches.map((match) => match.sample.id);
    expect(percentIds).toContain(percent.id);
    expect(percentIds).not.toContain(decoy.id);
    expect(byPercent.matches.length).toBeGreaterThan(0);

    const byUnderscore = await kernel.search.searchBySpec({ query: "_", limit: 100 });
    expect(byUnderscore.matches.map((match) => match.sample.id)).toContain(underscore.id);

    const byCode = await kernel.search.searchBySpec({ query: "SMP%", limit: 100 });
    const codeIds = byCode.matches.map((match) => match.sample.id);
    expect(codeIds).toContain(percentCode.id);
    expect(codeIds).not.toContain(plainCode.id);
  }, 20_000);

  it("审计日志：数据库层面禁止 UPDATE / DELETE", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const latest = await kernel.audit.list(1);
    const target = latest[0];
    expect(target).toBeDefined();
    const failure = await db!
      .execute(sql`UPDATE audit_log SET actor_id = 'tampered' WHERE seq = ${target!.seq}`)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).not.toBeNull();
    expect(errorChainMessage(failure)).toContain("append-only");
  }, 20_000);
});
