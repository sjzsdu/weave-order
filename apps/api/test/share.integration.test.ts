import {
  auditLog,
  createDb,
  DEFAULT_TENANT_ID,
  orders,
  quoteShareEvents,
  quoteShares,
  quotes,
  tenants,
} from "@weave-order/db";
import type { Db } from "@weave-order/db";
import type { CustomerQuotePage } from "@weave-order/schema";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel, QuoteLinkError } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";
import { PublicShareService } from "../src/shares/public-share.service";

/**
 * 客户报价链接（E3）集成测试：需要本地 PostgreSQL。
 * 覆盖「业务员生成链接 → 客户无登录查看/接受/提问 → 业务员看到访问数据」，
 * 以及过期、撤回、手机尾号、草稿不可分享等边界。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "e3-sales" } };
const AGENT: KernelContext = { actor: { type: "AGENT", id: "e3-agent" } };
const OWNER: KernelContext = {
  actor: { type: "HUMAN", id: "e3-owner", role: "OWNER" },
  dataScope: "ALL",
};
const SALES: KernelContext = {
  actor: { type: "HUMAN", id: "e3-sales-2", role: "SALES" },
  dataScope: "OWN",
};
const VISITOR = { ip: "203.0.113.9", userAgent: "vitest-agent" };

let available = false;
let db: Db | null = null;
let publicPool: Pool | null = null;

beforeAll(async () => {
  const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const table = await probe.query<{ exists: boolean }>(
      "SELECT to_regclass('public.quote_shares') IS NOT NULL AS exists",
    );
    available = table.rows[0]?.exists === true;
    if (available) {
      db = createDb(DATABASE_URL).db;
      publicPool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    }
  } catch {
    available = false;
  } finally {
    await probe.end();
  }
});

afterAll(async () => {
  await publicPool?.end();
});

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function kernelOf(): Kernel {
  if (!db) throw new Error("数据库不可用");
  return createKernel(db);
}

async function approvedQuote(kernel: Kernel) {
  const id = suffix();
  const customer = await kernel.customers.create(
    {
      code: `E3-C-${id}`,
      name: "杭州青禾服饰",
      contactName: "周敏",
      contactPhone: "13800136621",
    },
    HUMAN,
  );
  const sample = await kernel.samples.create(
    {
      code: `E3-S-${id}`,
      name: "32S 精梳棉汗布 220g",
      unit: "meter",
      costFloor: { amount: 1200, currency: "CNY" },
    },
    HUMAN,
  );
  const draft = await kernel.quotes.generateDraft(
    {
      customerId: customer.id,
      currency: "CNY",
      validityDays: 30,
      items: [
        {
          fabricSampleId: sample.id,
          quantity: { value: 500, unit: "meter" },
          unitPrice: { amount: 1520, currency: "CNY" },
        },
      ],
    },
    AGENT,
  );
  await kernel.quotes.confirmDraft(draft.id, HUMAN);
  return { customer, sample, quoteId: draft.id };
}

describe("客户报价链接（集成）", () => {
  it("只有已批准的报价能生成链接，且数据库只存 token 哈希", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const database = db;
    if (!database) throw new Error("数据库不可用");

    const id = suffix();
    const customer = await kernel.customers.create(
      { code: `E3-DRAFT-C-${id}`, name: "草稿客户" },
      HUMAN,
    );
    const sample = await kernel.samples.create(
      {
        code: `E3-DRAFT-S-${id}`,
        name: "草稿面料",
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
            unitPrice: { amount: 2000, currency: "CNY" },
          },
        ],
      },
      AGENT,
    );
    await expect(kernel.shares.createForQuote(draft.id, {}, HUMAN)).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "QUOTE_NOT_APPROVED" },
    });

    const approved = await approvedQuote(kernel);
    const created = await kernel.shares.createForQuote(
      approved.quoteId,
      { requirePhoneTail: true, allowPdf: true },
      HUMAN,
    );
    expect(created.token.length).toBeGreaterThan(32);
    expect(created.token.length).toBeLessThanOrEqual(256);
    expect(created.url.endsWith(`/s/${created.token}`)).toBe(true);
    expect(created.share.tokenHash).not.toBe(created.token);

    // 默认有效期 = 报价有效期（§7.6 规则 3），不被契约里 14 天的默认值截断。
    const quoteRows = await database
      .select({ expiresAt: quotes.expiresAt })
      .from(quotes)
      .where(eq(quotes.id, approved.quoteId));
    expect(new Date(created.share.expiresAt).getTime()).toBe(quoteRows[0]?.expiresAt.getTime());

    const rows = await database
      .select()
      .from(quoteShares)
      .where(eq(quoteShares.id, created.share.id));
    expect(rows[0]?.tokenHash).toBe(created.share.tokenHash);
    expect(JSON.stringify(rows[0])).not.toContain(created.token);
  }, 30_000);

  it("客户无登录查看 → 接受（手机尾号）→ 提问；业务员看到访问数据", async (ctx) => {
    if (!available || !publicPool) ctx.skip();
    const pool = publicPool;
    if (!pool) throw new Error("数据库不可用");
    const database = db;
    if (!database) throw new Error("数据库不可用");
    const kernel = kernelOf();
    const share = new PublicShareService(pool);
    const { quoteId } = await approvedQuote(kernel);
    const created = await kernel.shares.createForQuote(
      quoteId,
      { requirePhoneTail: true, allowPdf: true },
      HUMAN,
    );

    const before = await database
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, DEFAULT_TENANT_ID));
    await database
      .update(tenants)
      .set({
        settings: {
          salesContact: {
            name: "李娜",
            phone: "13800136621",
            wechatQrUrl: "https://cdn.example.com/qr/li-na.png",
          },
        },
      })
      .where(eq(tenants.id, DEFAULT_TENANT_ID));
    let page: CustomerQuotePage;
    try {
      page = await share.view(created.token, VISITOR);
    } finally {
      await database
        .update(tenants)
        .set({ settings: before[0]?.settings ?? {} })
        .where(eq(tenants.id, DEFAULT_TENANT_ID));
    }
    expect(page.view.customerName).toBe("杭州青禾服饰");
    expect(page.view.quoteNumber).toMatch(/^Q-\d{8}-[0-9A-F]{6}$/);
    expect(page.view.lines).toHaveLength(1);
    expect(page.view.lines[0]).toMatchObject({
      description: "32S 精梳棉汗布 220g",
      quantity: 500,
      unitPriceAmount: 1520,
      lineTotalAmount: 760000,
    });
    expect(page.view.totalAmount).toBe(760000);
    expect(page.remainingDays).toBeGreaterThan(0);
    expect(page.salesContact).toEqual({
      name: "李娜",
      phoneMasked: "138****6621",
      wechatQrUrl: "https://cdn.example.com/qr/li-na.png",
    });
    // 客户视图绝不包含成本 / 毛利 / 内部备注
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("costFloor");
    expect(serialized).not.toContain("margin");
    expect(serialized).not.toContain("remarks");
    expect(serialized).not.toContain("13800136621");

    await expect(share.accept(created.token, { phoneTail: "0000" }, VISITOR)).rejects.toMatchObject(
      {
        code: "PHONE_TAIL_MISMATCH",
      },
    );
    await expect(share.accept(created.token, {}, VISITOR)).rejects.toMatchObject({
      code: "PHONE_TAIL_REQUIRED",
    });

    const ordersBefore = await database
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.tenantId, DEFAULT_TENANT_ID));

    const accepted = await share.accept(created.token, { phoneTail: "6621" }, VISITOR);
    expect(accepted.alreadyAccepted).toBe(false);
    expect(accepted.nextStep).toContain("成交意向");
    const again = await share.accept(created.token, { phoneTail: "6621" }, VISITOR);
    expect(again.alreadyAccepted).toBe(true);
    expect(again.acceptedAt).toBe(accepted.acceptedAt);

    // 幂等不只是「返回同一个 acceptedAt」：事件表只能有一条 ACCEPTED，订单表不能多行。
    const acceptedEvents = await database
      .select({ id: quoteShareEvents.id })
      .from(quoteShareEvents)
      .where(
        and(eq(quoteShareEvents.shareId, created.share.id), eq(quoteShareEvents.event, "ACCEPTED")),
      );
    expect(acceptedEvents).toHaveLength(1);
    const ordersAfter = await database
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.tenantId, DEFAULT_TENANT_ID));
    expect(ordersAfter).toHaveLength(ordersBefore.length);

    const question = await share.ask(
      created.token,
      { message: "这个克重有没有更厚的？", lineIndex: 0 },
      VISITOR,
    );
    expect(question.eventId).toBeTruthy();

    await share.recordPdf(created.token, VISITOR);
    await share.view(created.token, { ip: "203.0.113.10", userAgent: "second-phone" });

    const stats = await kernel.shares.listForQuote(quoteId);
    const entry = stats.shares.find((row) => row.shareId === created.share.id);
    expect(entry).toMatchObject({
      viewCount: 2,
      uniqueVisitors: 2,
      pdfDownloadCount: 1,
      questionCount: 1,
    });
    expect(entry?.acceptedAt).toBe(accepted.acceptedAt);
    expect(entry?.questions[0]?.message).toBe("这个克重有没有更厚的？");
    expect(entry?.questions[0]?.lineIndex).toBe(0);

    // 接受不等于合同：报价账本状态仍是 SENT，没有变成订单/合同。
    const quoteRows = await db!
      .select({ status: quotes.status })
      .from(quotes)
      .where(eq(quotes.id, quoteId));
    expect(quoteRows[0]?.status).toBe("SENT");
  }, 30_000);

  it("撤回后立即 410 语义；过期链接不可再看", async (ctx) => {
    if (!available || !publicPool) ctx.skip();
    const pool = publicPool;
    if (!pool) throw new Error("数据库不可用");
    const kernel = kernelOf();
    const share = new PublicShareService(pool);
    const database = db;
    if (!database) throw new Error("数据库不可用");
    const { quoteId } = await approvedQuote(kernel);

    const revoked = await kernel.shares.createForQuote(quoteId, {}, HUMAN);
    await kernel.shares.revoke(revoked.share.id, HUMAN);
    await expect(share.view(revoked.token, VISITOR)).rejects.toMatchObject({
      code: "REVOKED",
    });

    const expired = await kernel.shares.createForQuote(quoteId, {}, HUMAN);
    await database
      .update(quoteShares)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(quoteShares.id, expired.share.id));
    await expect(share.view(expired.token, VISITOR)).rejects.toMatchObject({
      code: "EXPIRED",
    });
  }, 30_000);

  it("篡改 token 无法定位任何分享", async (ctx) => {
    if (!available || !publicPool) ctx.skip();
    const pool = publicPool;
    if (!pool) throw new Error("数据库不可用");
    const kernel = kernelOf();
    const share = new PublicShareService(pool);
    const { quoteId } = await approvedQuote(kernel);
    const created = await kernel.shares.createForQuote(quoteId, {}, HUMAN);
    const tampered = `${created.token.slice(0, -2)}xx`;
    await expect(share.view(tampered, VISITOR)).rejects.toBeInstanceOf(QuoteLinkError);
    await expect(share.view(tampered, VISITOR)).rejects.toMatchObject({ code: "INVALID_LINK" });
  }, 30_000);

  /**
   * 用独立租户而不是默认租户：vitest 按文件并行，改默认租户的开关会把同进程其它用例带崩。
   * 独立租户还能顺便验证「按租户生效」——另一个租户的链接不受影响。
   */
  it("租户开关关闭后，已生成链接立即失效、不能新建；重新开启立即恢复", async (ctx) => {
    if (!available || !publicPool) ctx.skip();
    const pool = publicPool;
    if (!pool) throw new Error("数据库不可用");
    const database = db;
    if (!database) throw new Error("数据库不可用");

    const tenantId = randomUUID();
    await database.insert(tenants).values({
      id: tenantId,
      slug: `e3-switch-${suffix()}`,
      name: "开关测试公司",
      settings: {
        salesContact: { name: "李娜", phone: "13800136621", wechatQrUrl: null },
      },
    });
    const kernel = createKernel(database, undefined, { tenantId });
    const share = new PublicShareService(pool);
    const { quoteId } = await approvedQuote(kernel);
    const created = await kernel.shares.createForQuote(quoteId, {}, HUMAN);

    await expect(share.view(created.token, VISITOR)).resolves.toBeTruthy();
    await expect(kernel.shares.getSharingSettings(OWNER)).resolves.toEqual({ enabled: true });

    await kernel.shares.updateSharingSettings({ enabled: false }, OWNER);
    await expect(kernel.shares.getSharingSettings(OWNER)).resolves.toEqual({ enabled: false });

    // 已生成的链接立即失效；三种客户写操作同样被挡在 requireActiveShare。
    await expect(share.view(created.token, VISITOR)).rejects.toMatchObject({
      code: "INVALID_LINK",
    });
    await expect(share.accept(created.token, {}, VISITOR)).rejects.toMatchObject({
      code: "INVALID_LINK",
    });
    await expect(share.ask(created.token, { message: "还在吗" }, VISITOR)).rejects.toMatchObject({
      code: "INVALID_LINK",
    });
    await expect(share.recordPdf(created.token, VISITOR)).rejects.toMatchObject({
      code: "INVALID_LINK",
    });

    // 关闭期间不再签发新链接，但业务员仍能看到 / 撤回存量链接。
    await expect(kernel.shares.createForQuote(quoteId, {}, HUMAN)).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "SHARING_DISABLED" },
    });
    await expect(kernel.shares.listForQuote(quoteId)).resolves.toMatchObject({
      shares: [{ shareId: created.share.id }],
    });

    // 审计留痕，且只改开关、不覆盖销售名片等既有设置。
    const audits = await database
      .select({ action: auditLog.action, before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "QUOTE_SHARING_UPDATED")));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.before).toMatchObject({ enabled: true });
    expect(audits[0]?.after).toMatchObject({ enabled: false });
    const tenantRows = await database
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    expect(tenantRows[0]?.settings).toMatchObject({
      quoteSharingEnabled: false,
      salesContact: { name: "李娜" },
    });

    // 角色权限：SALES 没有 settings.edit，不能自己把公开面打开。
    await expect(
      kernel.shares.updateSharingSettings({ enabled: true }, SALES),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    await kernel.shares.updateSharingSettings({ enabled: true }, OWNER);
    await expect(share.view(created.token, VISITOR)).resolves.toBeTruthy();
  }, 30_000);
});
