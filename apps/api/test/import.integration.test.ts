import { eq, inArray } from "drizzle-orm";
import {
  auditLog,
  customerContexts,
  customers,
  quotes,
  sampleShipments,
  samples,
} from "@weave-order/db";
import { createDb } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import { CustomerContext } from "@weave-order/schema";
import type { CreateSampleInput, FabricSample } from "@weave-order/schema";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";
import { CustomerService } from "../src/kernel/customers.service";
import { ImportService } from "../src/kernel/import.service";
import { SampleService } from "../src/kernel/samples.service";
import { createEmbeddingProvider } from "../src/platform/embedding";

/**
 * 数据导入集成测试：真实 PostgreSQL，验证「整批原子、全量校验、单事务回滚」口径。
 * 没有本地 PG 时整组跳过，`pnpm test` 离线仍全绿。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "import-it" } };
const AGENT: KernelContext = { actor: { type: "AGENT", id: "import-it-agent" } };

let pool: Pool | null = null;
let db: Db | null = null;
let service: ImportService | null = null;
let available = false;

beforeAll(async () => {
  const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const table = await probe.query<{ exists: boolean }>(
      "SELECT to_regclass('public.customers') IS NOT NULL AS exists",
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
    const embedder = createEmbeddingProvider();
    service = new ImportService(
      handle.db,
      new CustomerService(handle.db),
      new SampleService(handle.db, embedder),
      embedder,
    );
  }
});

afterAll(async () => {
  await pool?.end();
});

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const customerRow = (code: string, overrides: Record<string, unknown> = {}) => ({
  code,
  name: `客户-${code}`,
  ...overrides,
});
const sampleRow = (code: string, overrides: Record<string, unknown> = {}) => ({
  code,
  name: `面料-${code}`,
  unit: "meter",
  costFloor: { amount: 1200, currency: "CNY" },
  ...overrides,
});

async function presentCustomerCodes(codes: string[]): Promise<string[]> {
  if (!db || codes.length === 0) return [];
  const rows = await db
    .select({ code: customers.code })
    .from(customers)
    .where(inArray(customers.code, codes));
  return rows.map((row) => row.code);
}

async function presentSampleCodes(codes: string[]): Promise<string[]> {
  if (!db || codes.length === 0) return [];
  const rows = await db
    .select({ code: samples.code })
    .from(samples)
    .where(inArray(samples.code, codes));
  return rows.map((row) => row.code);
}

async function customerIdByCode(code: string): Promise<string | undefined> {
  if (!db) return undefined;
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.code, code))
    .limit(1);
  return rows[0]?.id;
}

describe("数据导入（集成，整批原子 / 单事务回滚）", () => {
  it("合法行整批提交：账本落库、HUMAN 审计同 correlationId、CustomerContext 就位", async (ctx) => {
    const database = db;
    const importer = service;
    if (!available || !database || !importer) {
      ctx.skip();
      return;
    }
    const s = suffix();
    const c1 = `IT-IMP-C1-${s}`;
    const c2 = `IT-IMP-C2-${s}`;
    const x1 = `IT-IMP-S1-${s}`;

    const result = await importer.execute(
      {
        customers: [
          customerRow(c1, { context: { preferenceNotes: ["偏好高支棉"] } }),
          customerRow(c2),
        ],
        samples: [sampleRow(x1)],
      },
      HUMAN,
    );

    expect(result.committed).toBe(true);
    expect(result.batchError).toBeNull();
    expect(result.importedCustomers).toBe(2);
    expect(result.importedSamples).toBe(1);
    expect(result.rows.every((row) => row.ok)).toBe(true);
    const correlationId = result.correlationId;
    expect(correlationId).not.toBeNull();
    if (correlationId === null) return;

    // 账本直查：三类行都真的落库
    expect(await presentCustomerCodes([c1, c2])).toEqual(expect.arrayContaining([c1, c2]));
    expect(await presentSampleCodes([x1])).toEqual([x1]);

    // 审计：全部 HUMAN 上下文，同事务、共用 correlationId
    const entries = await database
      .select()
      .from(auditLog)
      .where(eq(auditLog.correlationId, correlationId));
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.actorType === "HUMAN")).toBe(true);
    expect(entries.map((entry) => entry.action).sort()).toEqual(
      ["CUSTOMER_CREATED", "CUSTOMER_CREATED", "SAMPLE_CREATED"].sort(),
    );

    // CustomerContext 存储与读取（P0 已有着落）：导入带的私有字段读得回
    const id = await customerIdByCode(c1);
    expect(id).toBeDefined();
    if (!id) return;
    const kernel = createKernel(database);
    const context = await kernel.customers.getContext(id);
    expect(CustomerContext.safeParse(context).success).toBe(true);
    expect(context.preferenceNotes).toEqual(["偏好高支棉"]);
    expect(context.decisionDeltas).toEqual([]);
    const history = await kernel.customers.getHistory(id, 5);
    expect(history.context.customerId).toBe(id);
  }, 20_000);

  it("坏行 → 整批拒绝、零写入，逐行可判别回执", async (ctx) => {
    const importer = service;
    if (!available || !importer) {
      ctx.skip();
      return;
    }
    const s = suffix();
    const goodCustomer = `IT-IMP-BAD-C-${s}`;
    const goodSample = `IT-IMP-BAD-S-${s}`;

    const result = await importer.execute(
      {
        customers: [customerRow(goodCustomer), { code: "", name: "", tier: "MADE_UP" }],
        samples: [sampleRow(goodSample)],
      },
      HUMAN,
    );

    expect(result.committed).toBe(false);
    expect(result.batchError?.code).toBe("BATCH_REJECTED");
    expect(result.importedCustomers).toBe(0);
    expect(result.importedSamples).toBe(0);
    const failed = result.rows.find((row) => !row.ok);
    expect(failed?.ok).toBe(false);
    if (failed && !failed.ok) {
      expect(failed.error.code).toBe("INVALID_INPUT");
      if (failed.error.code === "INVALID_INPUT")
        expect(failed.error.issues.length).toBeGreaterThan(0);
    }
    // 合法行仍有 ok 回执（便于修正后重导），但一行都没落库
    expect(result.rows.filter((row) => row.ok)).toHaveLength(2);
    expect(await presentCustomerCodes([goodCustomer])).toEqual([]);
    expect(await presentSampleCodes([goodSample])).toEqual([]);
  }, 20_000);

  it("批内 code 重复 → DUPLICATE_IN_BATCH、零写入", async (ctx) => {
    const importer = service;
    if (!available || !importer) {
      ctx.skip();
      return;
    }
    const dup = `IT-IMP-DUP-${suffix()}`;
    const result = await importer.execute(
      { customers: [customerRow(dup), customerRow(dup)] },
      HUMAN,
    );
    expect(result.committed).toBe(false);
    expect(result.batchError?.code).toBe("BATCH_REJECTED");
    const failed = result.rows.find((row) => !row.ok);
    if (failed && !failed.ok) {
      expect(failed.error.code).toBe("DUPLICATE_IN_BATCH");
      if (failed.error.code === "DUPLICATE_IN_BATCH") {
        expect(failed.error.conflictsWithRow).toBe(0);
      }
    }
    expect(await presentCustomerCodes([dup])).toEqual([]);
  }, 20_000);

  it("库中已有 code → DUPLICATE_IN_DB、整批零写入（含同批新行）", async (ctx) => {
    const database = db;
    const importer = service;
    if (!available || !database || !importer) {
      ctx.skip();
      return;
    }
    const s = suffix();
    const existing = `IT-IMP-EXIST-${s}`;
    const fresh = `IT-IMP-FRESH-${s}`;
    const kernel = createKernel(database);
    const created = await kernel.customers.create({ code: existing, name: "已存在客户" }, HUMAN);

    const result = await importer.execute(
      { customers: [customerRow(existing, { name: "换个名字" }), customerRow(fresh)] },
      HUMAN,
    );
    expect(result.committed).toBe(false);
    expect(result.batchError?.code).toBe("BATCH_REJECTED");
    const failed = result.rows.find((row) => !row.ok);
    if (failed && !failed.ok) {
      expect(failed.error.code).toBe("DUPLICATE_IN_DB");
      if (failed.error.code === "DUPLICATE_IN_DB") {
        expect(failed.error.existingId).toBe(created.id);
      }
    }
    // 关键：同批里本来合法的新行也没落库（整批不提交）
    expect(await presentCustomerCodes([fresh])).toEqual([]);
  }, 20_000);

  it("写入阶段部分失败 → 整批事务回滚、零脏数据（WRITE_FAILED）", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const s = suffix();
    const c1 = `IT-IMP-RB-C1-${s}`;
    const c2 = `IT-IMP-RB-C2-${s}`;
    const x1 = `IT-IMP-RB-S1-${s}`;
    const x2 = `IT-IMP-RB-S2-${s}`;

    //  FaultySampleService：让事务里第 4 个写入（第二件样品）抛错，
    //  前 3 行已经 insert，用来验证回滚后一行都不剩、审计也不残留。
    class FaultySampleService extends SampleService {
      override async insertWithin(
        tx: Tx,
        parsed: CreateSampleInput,
        ctx: KernelContext,
        embedding: number[],
      ): Promise<FabricSample> {
        if (parsed.code === x2) throw new Error("注入：第二件样品写入失败");
        return super.insertWithin(tx, parsed, ctx, embedding);
      }
    }
    const embedder = createEmbeddingProvider();
    const faulty = new ImportService(
      database,
      new CustomerService(database),
      new FaultySampleService(database, embedder),
      embedder,
    );

    // 只看本文件专用的 actorId，避免与并行其它测试文件的写入互相干扰。
    const auditBefore = await database
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorId, "import-it"));
    const result = await faulty.execute(
      {
        customers: [customerRow(c1), customerRow(c2)],
        samples: [sampleRow(x1), sampleRow(x2)],
      },
      HUMAN,
    );
    const auditAfter = await database
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorId, "import-it"));

    expect(result.committed).toBe(false);
    expect(result.batchError?.code).toBe("WRITE_FAILED");
    expect(result.importedCustomers).toBe(0);
    expect(result.importedSamples).toBe(0);
    expect(result.rows.every((row) => !row.ok)).toBe(true);
    // 事务回滚：已 insert 的客户/样品全部消失
    expect(await presentCustomerCodes([c1, c2])).toEqual([]);
    expect(await presentSampleCodes([x1, x2])).toEqual([]);
    // 同事务审计也一并回滚，不留脏记录
    expect(auditAfter.length).toBe(auditBefore.length);
  }, 20_000);

  it("resetExisting：同 code 旧行连同上下文 / 引用报价与寄样被替换，并留 IMPORT_RESET 审计", async (ctx) => {
    const database = db;
    const importer = service;
    if (!available || !database || !importer) {
      ctx.skip();
      return;
    }
    const s = suffix();
    const customerCode = `IT-IMP-RESET-C-${s}`;
    const sampleCode = `IT-IMP-RESET-S-${s}`;
    const kernel = createKernel(database);
    const oldCustomer = await kernel.customers.create(
      { code: customerCode, name: "重置前客户" },
      HUMAN,
    );
    const oldSample = await kernel.samples.create(
      {
        code: sampleCode,
        name: "重置前面料",
        unit: "meter",
        costFloor: { amount: 1200, currency: "CNY" },
      },
      HUMAN,
    );
    const quote = await kernel.quotes.generateDraft(
      {
        customerId: oldCustomer.id,
        currency: "CNY",
        validityDays: 30,
        items: [
          {
            fabricSampleId: oldSample.id,
            quantity: { value: 2, unit: "meter" },
            unitPrice: { amount: 1500, currency: "CNY" },
          },
        ],
      },
      HUMAN,
    );
    const shipment = await kernel.shipments.createDraft(
      {
        customerId: oldCustomer.id,
        items: [{ sampleId: oldSample.id, quantity: { value: 1, unit: "meter" } }],
      },
      HUMAN,
    );

    // 默认口径不受影响：同 code 仍然整批拒绝
    const rejected = await importer.execute(
      { customers: [customerRow(customerCode, { name: "重置后客户" })] },
      HUMAN,
    );
    expect(rejected.committed).toBe(false);
    expect(rejected.batchError?.code).toBe("BATCH_REJECTED");

    const result = await importer.execute(
      {
        customers: [
          customerRow(customerCode, {
            name: "重置后客户",
            context: { preferenceNotes: ["新偏好"] },
          }),
        ],
        samples: [sampleRow(sampleCode, { name: "重置后面料" })],
      },
      HUMAN,
      { resetExisting: true },
    );
    expect(result.committed).toBe(true);
    expect(result.importedCustomers).toBe(1);
    expect(result.importedSamples).toBe(1);
    const correlationId = result.correlationId;
    expect(correlationId).not.toBeNull();
    if (correlationId === null) return;

    const newCustomerId = await customerIdByCode(customerCode);
    expect(newCustomerId).toBeDefined();
    expect(newCustomerId).not.toBe(oldCustomer.id);
    // 旧客户上下文随旧客户一起删除，新上下文是新行
    const staleContext = await database
      .select()
      .from(customerContexts)
      .where(eq(customerContexts.customerId, oldCustomer.id));
    expect(staleContext).toHaveLength(0);
    if (!newCustomerId) return;
    const context = await kernel.customers.getContext(newCustomerId);
    expect(context.preferenceNotes).toEqual(["新偏好"]);

    // 引用旧客户 / 样品的报价与寄样单被连带清理
    expect(await database.select().from(quotes).where(eq(quotes.id, quote.id))).toHaveLength(0);
    expect(
      await database.select().from(sampleShipments).where(eq(sampleShipments.id, shipment.id)),
    ).toHaveLength(0);

    // 同一 correlationId 下四类旧实体都有 IMPORT_RESET 审计
    const audits = await database
      .select()
      .from(auditLog)
      .where(eq(auditLog.correlationId, correlationId));
    expect(audits.filter((entry) => entry.action === "IMPORT_RESET")).toHaveLength(4);
  }, 30_000);

  it("非 HUMAN 上下文 / 非法信封 → 可判别拒绝、零写入", async (ctx) => {
    const importer = service;
    if (!available || !importer) {
      ctx.skip();
      return;
    }
    const denied = `IT-IMP-DENY-${suffix()}`;
    const asAgent = await importer.execute({ customers: [customerRow(denied)] }, AGENT);
    expect(asAgent.committed).toBe(false);
    expect(asAgent.batchError?.code).toBe("PERMISSION_DENIED");
    expect(await presentCustomerCodes([denied])).toEqual([]);

    const badEnvelope = await importer.execute({ customers: "not-an-array" }, HUMAN);
    expect(badEnvelope.committed).toBe(false);
    expect(badEnvelope.batchError?.code).toBe("INVALID_BATCH");

    const empty = await importer.execute({}, HUMAN);
    expect(empty.committed).toBe(false);
    expect(empty.batchError?.code).toBe("INVALID_BATCH");
    expect(empty.importedCustomers).toBe(0);
    expect(empty.importedSamples).toBe(0);
  }, 20_000);
});
