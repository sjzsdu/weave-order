import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  customerContacts,
  customerContexts,
  customers,
  fieldOptions,
  quoteShareEvents,
  quoteShares,
  quotes,
  tenants,
} from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

/**
 * 多联系人集成测试（WAN-177）：需要本地 PostgreSQL（docker compose up -d && pnpm db:migrate）。
 * 没有数据库时整组跳过，纯离线环境仍全绿。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const OWNER: KernelContext = { actor: { type: "HUMAN", id: "contact-it-owner", role: "OWNER" } };
const VIEWER: KernelContext = { actor: { type: "HUMAN", id: "contact-it-viewer", role: "VIEWER" } };
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "contact-it-bootstrap" } };

let probe: Pool | null = null;
let available = false;
let db: Db | null = null;
const createdTenantIds: string[] = [];

beforeAll(async () => {
  probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const table = await probe.query<{ exists: boolean }>(
      "SELECT to_regclass('public.customer_contacts') IS NOT NULL AS exists",
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
    const ids = [...createdTenantIds];
    // 按外键顺序清理；audit_log 只追加，不清理（与其它集成测试一致）。
    await db.delete(quoteShareEvents).where(inArray(quoteShareEvents.tenantId, ids));
    await db.delete(quoteShares).where(inArray(quoteShares.tenantId, ids));
    await db.delete(quotes).where(inArray(quotes.tenantId, ids));
    await db.delete(customerContacts).where(inArray(customerContacts.tenantId, ids));
    await db.delete(customerContexts).where(inArray(customerContexts.tenantId, ids));
    await db.delete(customers).where(inArray(customers.tenantId, ids));
    await db.delete(fieldOptions).where(inArray(fieldOptions.tenantId, ids));
    await db.delete(tenants).where(inArray(tenants.id, ids));
  }
});

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function isolatedKernel(id: string): Promise<{ kernel: Kernel; tenantId: string }> {
  if (!db) throw new Error("数据库不可用");
  const bootstrap = createKernel(db);
  const tenant = await bootstrap.tenancy.createTenant(
    {
      slug: `it-contacts-${id}-${suffix()}`,
      name: `Contacts IT ${id}`,
      casdoorOrg: `it-contacts-${id}`,
    },
    SYSTEM,
  );
  createdTenantIds.push(tenant.id);
  return { kernel: createKernel(db, undefined, { tenantId: tenant.id }), tenantId: tenant.id };
}

function errorReason(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "details" in error) {
    return (error as { details?: { reason?: string } }).details?.reason;
  }
  return undefined;
}

describe("多联系人（集成）", () => {
  it("建客户：联系人行成为唯一事实源，旧三列同步投影", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedKernel("create");
    const customer = await kernel.customers.create(
      {
        code: `CT-${suffix()}`,
        name: "杭州青禾",
        contactName: "周敏",
        contactPhone: "138 0013-8000",
        contactEmail: "ZHOU@qinghe.com",
      },
      OWNER,
    );
    const contacts = await kernel.contacts.list(customer.id, OWNER);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      name: "周敏",
      isPrimary: true,
      phone: "138 0013-8000",
      email: "ZHOU@qinghe.com",
    });
    // 投影列仍在（本批不删旧列），但读模型取联系人。
    const rows = await db!
      .select({ name: customers.contactName, phone: customers.contactPhone })
      .from(customers)
      .where(eq(customers.id, customer.id));
    expect(rows[0]).toMatchObject({ name: "周敏", phone: "138 0013-8000" });
    expect(customer.contactName).toBe("周敏");
  });

  it("第一位联系人自动主；换主 / 归档主联系人必须选继任者", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedKernel("primary");
    const customer = await kernel.customers.create(
      { code: `CT-${suffix()}`, name: "多联系人客户", contactName: "采购甲" },
      OWNER,
    );
    const first = (await kernel.contacts.list(customer.id, OWNER))[0]!;

    const second = (
      await kernel.contacts.create(
        customer.id,
        { name: "财务乙", role: "财务", phone: "13900001111" },
        OWNER,
      )
    ).contact;
    expect(second.isPrimary).toBe(false);

    await kernel.contacts.setPrimary(second.id, OWNER);
    let contacts = await kernel.contacts.list(customer.id, OWNER);
    expect(contacts.find((contact) => contact.isPrimary)?.id).toBe(second.id);
    // 换主后客户档案投影跟着变。
    expect((await kernel.customers.getById(customer.id)).contactName).toBe("财务乙");

    await expect(kernel.contacts.archive(second.id, {}, OWNER)).rejects.toSatisfy(
      (error: unknown) => errorReason(error) === "CONTACT_SUCCESSOR_REQUIRED",
    );

    const archived = await kernel.contacts.archive(
      second.id,
      { successorContactId: first.id },
      OWNER,
    );
    expect(archived.contact.archivedAt).toBeTruthy();
    contacts = await kernel.contacts.list(customer.id, OWNER);
    expect(contacts.map((contact) => contact.id)).toEqual([first.id]);
    expect(contacts[0]?.isPrimary).toBe(true);
    expect((await kernel.customers.getById(customer.id)).contactName).toBe("采购甲");
  });

  it("同客户手机/邮箱重复阻断，跨客户同号只提示", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedKernel("duplicate");
    const a = await kernel.customers.create(
      {
        code: `CT-A-${suffix()}`,
        name: "客户 A",
        contactName: "甲",
        contactPhone: "13800138000",
        contactEmail: "same@example.com",
      },
      OWNER,
    );
    await expect(
      kernel.contacts.create(a.id, { name: "甲2", phone: "138 0013 8000" }, OWNER),
    ).rejects.toSatisfy((error: unknown) => errorReason(error) === "CONTACT_PHONE_DUPLICATE");
    await expect(
      kernel.contacts.create(a.id, { name: "甲3", email: "SAME@example.com" }, OWNER),
    ).rejects.toSatisfy((error: unknown) => errorReason(error) === "CONTACT_EMAIL_DUPLICATE");

    const b = await kernel.customers.create(
      { code: `CT-B-${suffix()}`, name: "客户 B", contactName: "乙" },
      OWNER,
    );
    const result = await kernel.contacts.create(b.id, { name: "乙", phone: "13800138000" }, OWNER);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.customerName).toBe("客户 A");
  });

  it("VIEWER 手机/邮箱掩码且不能写；OWNER 全量", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedKernel("pii");
    const customer = await kernel.customers.create(
      {
        code: `CT-${suffix()}`,
        name: "掩码客户",
        contactName: "周敏",
        contactPhone: "13800138000",
        contactEmail: "zhou@qinghe.com",
      },
      OWNER,
    );
    const ownerView = await kernel.contacts.list(customer.id, OWNER);
    expect(ownerView[0]?.phone).toBe("13800138000");

    const viewerView = await kernel.contacts.list(customer.id, VIEWER);
    expect(viewerView[0]?.phone).toBe("138****8000");
    expect(viewerView[0]?.email).toBe("z***@qinghe.com");

    const viewerCustomer = await kernel.customers.getById(customer.id, {
      ...VIEWER,
      dataScope: "ALL",
    });
    expect(viewerCustomer.contactPhone).toBe("138****8000");

    await expect(
      kernel.contacts.create(customer.id, { name: "新联系人" }, VIEWER),
    ).rejects.toSatisfy((error: unknown) => errorReason(error) === "CONTACT_PII_MASKED");
  });

  it("客户搜索命中联系人姓名 / 手机 / 微信", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedKernel("search");
    const customer = await kernel.customers.create(
      { code: `CT-${suffix()}`, name: "搜索客户", contactName: "周敏" },
      OWNER,
    );
    await kernel.contacts.create(
      customer.id,
      { name: "林工", role: "跟单", phone: "13712345678", wechat: "lingong_work" },
      OWNER,
    );
    const byName = await kernel.customers.list({ query: "林工" }, OWNER);
    expect(byName.map((row) => row.id)).toContain(customer.id);
    const byPhone = await kernel.customers.list({ query: "13712345678" }, OWNER);
    expect(byPhone.map((row) => row.id)).toContain(customer.id);
    const byWechat = await kernel.customers.list({ query: "lingong" }, OWNER);
    expect(byWechat.map((row) => row.id)).toContain(customer.id);
  });

  it("批量导出：VIEWER 掩码，写一条 AUDIT_EXPORTED", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedKernel("export");
    const customer = await kernel.customers.create(
      {
        code: `CT-${suffix()}`,
        name: "导出客户",
        contactName: "周敏",
        contactPhone: "13800138000",
        contactEmail: "zhou@qinghe.com",
      },
      OWNER,
    );
    const ownerExport = await kernel.contacts.exportCsv(OWNER);
    expect(ownerExport.csv).toContain("13800138000");
    expect(ownerExport.masked).toBe(false);

    const viewerExport = await kernel.contacts.exportCsv(VIEWER);
    expect(viewerExport.csv).toContain("138****8000");
    expect(viewerExport.masked).toBe(true);

    const audit = await kernel.audit.list(5);
    expect(audit.some((entry) => entry.action === "AUDIT_EXPORTED")).toBe(true);
    expect(customer.id).toBeTruthy();
  });

  it("0026 迁移自带回填：老客户升级后已有主联系人且幂等", async (ctx) => {
    if (!available) ctx.skip();
    const { tenantId } = await isolatedKernel("backfill");
    // 绕过内核直接写一条「旧版」客户：只填三列、没有联系人行，模拟升级前的数据。
    const rows = await db!
      .insert(customers)
      .values({
        tenantId,
        code: `CT-LEGACY-${suffix()}`,
        name: "旧数据客户",
        contactName: "老周",
        contactPhone: "+86 138 0000 1111",
        contactEmail: null,
      })
      .returning();
    const legacy = rows[0]!;

    // 直接取 0026 迁移文件里的回填语句：测试不能自己抄一份，否则迁移丢语句也测不出来。
    // vitest 的 cwd 是 apps/api：从仓库根取真实迁移文件。
    const migration = await readFile(
      path.resolve(process.cwd(), "../../packages/db/drizzle/0026_broad_silver_surfer.sql"),
      "utf8",
    );
    const backfill = migration
      .split("--> statement-breakpoint")
      .find((statement) => statement.includes('INSERT INTO "customer_contacts"'));
    expect(backfill, "0026 迁移必须包含存量联系人回填").toBeTruthy();

    // 迁移里的语句是整表回填；测试库还有其它租户的存量行，两次执行都必须只给本客户建一条。
    await db!.execute(sql.raw(backfill!));
    await db!.execute(sql.raw(backfill!));

    const contacts = await db!
      .select()
      .from(customerContacts)
      .where(eq(customerContacts.customerId, legacy.id));
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      name: "老周",
      phone: "+86 138 0000 1111",
      phoneNormalized: "+8613800001111",
      email: null,
      isPrimary: true,
    });
  });

  it("外发记录带 contact_id + 快照", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel, tenantId } = await isolatedKernel("share");
    const customer = await kernel.customers.create(
      { code: `CT-${suffix()}`, name: "分享客户", contactName: "周敏" },
      OWNER,
    );
    const buyer = (
      await kernel.contacts.create(
        customer.id,
        { name: "林采", role: "采购", email: "lin@example.com" },
        OWNER,
      )
    ).contact;

    // 直接落一条已发出的报价：本用例只关心分享记录，不重复报价内核路径。
    const quoteRows = await db!
      .insert(quotes)
      .values({
        tenantId,
        customerId: customer.id,
        status: "SENT",
        currency: "CNY",
        subtotalAmount: 10000,
        totalAmount: 10000,
        validityDays: 7,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      })
      .returning();
    const quote = quoteRows[0]!;

    // 不传 contactId：报价默认找「采购」，并写入发送快照。
    const share = await kernel.shares.createForQuote(quote.id, {}, OWNER);
    expect(share.share.contactId).toBe(buyer.id);
    expect(share.share.contactSnapshot).toEqual({ name: "林采", email: "lin@example.com" });
    const stored = await db!.select().from(quoteShares).where(eq(quoteShares.id, share.share.id));
    expect(stored[0]?.contactId).toBe(buyer.id);
  });
});
