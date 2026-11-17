import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlatformDb, resolvePlatformDatabaseUrl } from "@weave-order/control-db";
import type { PlatformDb } from "@weave-order/control-db";
import { AccountExecutor } from "./helpers/actor";
import { AuditService } from "../src/control/audit.service";
import { PricingService } from "../src/control/pricing.service";
import { TenantsService } from "../src/control/tenants.service";
import { PlatformError } from "../src/domain/errors";

/**
 * 空控制面冷启动：WAN-164。
 *
 * 生产部署不会执行 `platform:seed`（有生产闸门），所以默认套餐与初始价格表必须随
 * `platform:migrate` 写入。这里验证三件事：
 * 1. 迁移后的库里至少有默认套餐与一份生效价格表；
 * 2. 默认 SQL 可重复执行（幂等），不会重复插入或覆盖；
 * 3. 只剩「新套餐」这一种冷启动入口时，owner 能建套餐并开通试用租户。
 *
 * 没有控制面库时整组跳过，离线 `pnpm test` 仍然全绿。
 */
const URL = process.env.PLATFORM_DATABASE_URL ?? resolvePlatformDatabaseUrl();
let db: PlatformDb | null = null;
let pool: ReturnType<typeof createPlatformDb>["pool"] | null = null;
let available = false;

let pricing: PricingService;
let tenants: TenantsService;

const owner = AccountExecutor("wan164-owner", "platform_owner");
const DEFAULT_PLAN_CODES = ["TRIAL", "STARTER", "PRO", "ENTERPRISE"] as const;
const DEFAULTS_SQL = path.join(
  process.cwd(),
  "../../packages/control-db/sql/platform-defaults.sql",
);

beforeAll(async () => {
  try {
    const handle = createPlatformDb(URL);
    pool = handle.pool;
    const check = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('control.plans') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (!available) {
      await pool.end();
      pool = null;
      return;
    }
    db = handle.db;
    const audit = new AuditService(db);
    pricing = new PricingService(db, audit);
    tenants = new TenantsService(db, audit);
  } catch {
    available = false;
    await pool?.end();
    pool = null;
  }
});

afterAll(async () => {
  await pool?.end();
});

describe("空控制面冷启动（集成）", () => {
  it("迁移后自带默认套餐", async (ctx) => {
    if (!available) ctx.skip();
    const list = await pricing.listPlans();
    const codes = list.map((plan) => plan.code);
    for (const code of DEFAULT_PLAN_CODES) {
      expect(codes, `缺少默认套餐 ${code}`).toContain(code);
    }
    expect(list.every((plan) => plan.status === "ACTIVE")).toBe(true);
  });

  it("迁移后自带一份生效价格表，且默认套餐都有价格", async (ctx) => {
    if (!available) ctx.skip();
    const books = await pricing.listBooks();
    const active = books.find((book) => book.status === "ACTIVE");
    expect(active, "没有生效中的价格表，/pricing 无法试算与开通租户").toBeTruthy();
    if (!active) return;
    const detail = await pricing.getBook(active.id);
    const priced = new Set(detail.prices.map((price) => price.planCode));
    for (const code of DEFAULT_PLAN_CODES) {
      expect(priced, `价格表缺少 ${code} 的价格`).toContain(code);
    }
  });

  it("默认 SQL 可重复执行（幂等）", async (ctx) => {
    const dbPool = pool;
    if (!available || !dbPool) {
      ctx.skip();
      return;
    }
    const sql = await readFile(DEFAULTS_SQL, "utf8");
    const before = await dbPool.query<{ plans: string; books: string; prices: string }>(
      `SELECT
         (SELECT count(*) FROM control.plans) AS plans,
         (SELECT count(*) FROM control.price_books) AS books,
         (SELECT count(*) FROM control.plan_prices) AS prices`,
    );
    await dbPool.query(sql);
    await dbPool.query(sql);
    const after = await dbPool.query<{ plans: string; books: string; prices: string }>(
      `SELECT
         (SELECT count(*) FROM control.plans) AS plans,
         (SELECT count(*) FROM control.price_books) AS books,
         (SELECT count(*) FROM control.plan_prices) AS prices`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("owner 可以新建套餐，重复代码返回 409", async (ctx) => {
    if (!available) ctx.skip();
    const code = `W164_${randomUUID().slice(0, 6)}`.toUpperCase();
    const created = await pricing.createPlan(owner, {
      code,
      name: "冷启动测试套餐",
      tier: 4,
      seatMin: 2,
      seatMax: 8,
      agentActionsQuota: 1234,
      storageGb: 7,
      features: { customer_portal: true },
    });
    expect(created.code).toBe(code);
    expect(created.seatMax).toBe(8);

    const list = await pricing.listPlans();
    expect(list.map((plan) => plan.code)).toContain(code);

    await expect(
      pricing.createPlan(owner, { code, name: "重复套餐", tier: 4 }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<PlatformError>);
  });

  it("非法套餐代码被拒绝（不会写进控制面）", async (ctx) => {
    if (!available) ctx.skip();
    await expect(
      pricing.createPlan(owner, { code: "bad code", name: "非法", tier: 1 }),
    ).rejects.toThrow();
    await expect(pricing.createPlan(owner, { code: "XX", name: "", tier: 1 })).rejects.toThrow();
  });

  it("新套餐可以配进价格表，并能用默认套餐开通试用租户", async (ctx) => {
    if (!available) ctx.skip();
    const code = `W164B_${randomUUID().slice(0, 6)}`.toUpperCase();
    await pricing.createPlan(owner, {
      code,
      name: "冷启动定价套餐",
      tier: 5,
      seatMin: 3,
      seatMax: 10,
      agentActionsQuota: 500,
      storageGb: 3,
    });
    const book = await pricing.createBook(owner, {
      notes: `WAN-164 集成用例 ${code}`,
      prices: [{ planCode: code, monthlyPriceCents: 12300, annualPriceCents: 123000 }],
    });
    expect(book.book.status).toBe("DRAFT");
    expect(book.prices.some((price) => price.planCode === code)).toBe(true);

    const slug = `wan164-${randomUUID().slice(0, 8)}`;
    const tenant = await tenants.provision(owner, {
      name: `冷启动公司-${slug}`,
      slug,
      planCode: "TRIAL",
      seats: 3,
      billingCycle: "MONTHLY",
      trialDays: 3,
      region: "cn-east",
    });
    expect(tenant.slug).toBe(slug);
    expect(tenant.status).toBe("TRIAL");
    expect(tenant.planCode).toBe("TRIAL");
  });
});
