import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";
import { InboundIntakeService } from "../src/http/inbound-intake.service";

/**
 * 手工录入客户回复（真连 PG）：
 * - 验收 1/2 的落库与识别链路：文本 → inbound_messages → 客户 360 时间线 → 识别询价 → DRAFT；
 * - 验收 3：同 (channel, externalId) 重复提交只落一条、只出一份草稿；
 * - 验收 4：入库文本已脱敏；
 * - 评审 D2：截图 raw_payload 的到期时间落库。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "inbound-bootstrap" } };

let pool: Pool | null = null;
let db: Db | null = null;
let available = false;
const createdTenants: string[] = [];
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 3 });
  try {
    const check = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.inbound_messages') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (available) db = createDb(DATABASE_URL).db;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (pool && available && createdTenants.length > 0) {
    await pool.query("DELETE FROM inbound_messages WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM quote_items WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM quotes WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM samples WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM customer_contexts WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM customers WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM memberships WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  }
  await pool?.end();
});

describe("手工录入客户回复（真连 PG）", () => {
  it("文本 → 时间线 → 识别询价 → 报价草稿 DRAFT；重复提交不重复出草稿", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const bootstrap = createKernel(database);
    const tenant = await bootstrap.tenancy.createTenant(
      { slug: `inbound-${id}`, name: `录入 ${id}`, casdoorOrg: `inbound-${id}` },
      SYSTEM,
    );
    createdTenants.push(tenant.id);
    const kernel = createKernel(database, undefined, { tenantId: tenant.id });
    const membership = await kernel.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: `inbound-sales-${id}`,
        casdoorOrg: `inbound-${id}`,
        role: "MANAGER",
        dataScope: "ALL",
      },
      SYSTEM,
    );
    const human: KernelContext = {
      actor: { type: "HUMAN", id: `subject-${membership.id}`, role: "MANAGER" },
      dataScope: "ALL",
      ownerId: membership.id,
      teamId: null,
    };

    const customer = await kernel.customers.create({ code: `IN-C-${id}`, name: "录入客户" }, human);
    const sample = await kernel.samples.create(
      {
        code: `IN-S-${id}`,
        name: "录入用面料",
        composition: "100% 棉",
        weight: "220g/m2",
        unit: "meter",
        costFloor: { amount: 1200, currency: "CNY" },
      },
      human,
    );

    const intake = new InboundIntakeService();
    const body = {
      channel: "manual" as const,
      externalId: `ext-${id}`,
      customerId: customer.id,
      sampleId: sample.id,
      text: "这款 220g 棉，要 500 米，报价多少钱？电话 13800138000，邮箱 a@b.com",
    };

    const first = await intake.run(kernel, human, body);

    expect(first.classification?.intent).toBe("PRICE_REQUEST");
    expect(first.quoteDraftId).not.toBeNull();
    expect(first.draftError).toBeNull();
    // 验收 4：入库正文脱敏，原文不落库。
    expect(first.message.text).not.toContain("13800138000");
    expect(first.message.text).not.toContain("a@b.com");
    expect(first.message.customerId).toBe(customer.id);
    expect(first.message.consumedAt).not.toBeNull();

    const draft = await kernel.quotes.get(first.quoteDraftId as string, human);
    expect(draft.draft.status).toBe("DRAFT");
    expect(draft.draft.items[0]?.fabricSampleId).toBe(sample.id);
    // 出处写进备注：审批卡能看到这条草稿由哪条手工回复生成。
    expect(draft.draft.remarks).toContain(first.message.id);

    // 验收 1：客户 360 时间线出现该回复。
    const timeline = await kernel.customers.customerTimeline(customer.id, {}, human);
    const inboundEvents = timeline.events.filter((event) => event.kind === "inbound_reply");
    expect(inboundEvents).toHaveLength(1);
    expect(inboundEvents[0]?.refId).toBe(first.message.id);

    // 验收 3：重复提交同一 externalId → 同一条消息 / 同一份草稿。
    const replay = await intake.run(kernel, human, body);
    expect(replay.message.id).toBe(first.message.id);
    expect(replay.quoteDraftId).toBe(first.quoteDraftId);
    const rows = await database.execute<{ count: string }>(
      `SELECT count(*)::text AS count FROM inbound_messages WHERE tenant_id = '${tenant.id}'::uuid`,
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("截图录入落库 raw_payload 只存 objectKey，并写入可配的到期时间（D2）", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const bootstrap = createKernel(database);
    const tenant = await bootstrap.tenancy.createTenant(
      { slug: `inbound-shot-${id}`, name: `截图 ${id}`, casdoorOrg: `inbound-shot-${id}` },
      SYSTEM,
    );
    createdTenants.push(tenant.id);
    const kernel = createKernel(database, undefined, { tenantId: tenant.id });
    const membership = await kernel.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: `inbound-shot-${id}`,
        casdoorOrg: `inbound-shot-${id}`,
        role: "MANAGER",
        dataScope: "ALL",
      },
      SYSTEM,
    );
    const human: KernelContext = {
      actor: { type: "HUMAN", id: `subject-${membership.id}`, role: "MANAGER" },
      dataScope: "ALL",
      ownerId: membership.id,
      teamId: null,
    };
    const customer = await kernel.customers.create(
      { code: `SHOT-C-${id}`, name: "截图客户" },
      human,
    );

    const message = await kernel.inboundReplies.ingest(
      {
        channel: "screenshot",
        externalId: `shot-${id}`,
        customerId: customer.id,
        objectKey: `tenant/${tenant.id}/inbound/44444444-4444-4444-8444-444444444444.png`,
      },
      // OCR 由 platform provider 注入；这里用固定文本验证落库与保留期。
      { ocr: () => Promise.resolve({ text: "客户：这款还有现货吗？" }) },
    );

    expect(message.rawPayload).toEqual({
      objectKey: `tenant/${tenant.id}/inbound/44444444-4444-4444-8444-444444444444.png`,
    });
    expect(message.rawPayloadExpiresAt).not.toBeNull();
    const days =
      (Date.parse(message.rawPayloadExpiresAt as string) - Date.parse(message.receivedAt)) /
      86_400_000;
    expect(days).toBeGreaterThanOrEqual(29.9);
    expect(days).toBeLessThanOrEqual(30.1);
  });
});
