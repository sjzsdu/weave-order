import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApprovalDecisionResult,
  QuoteDetail,
  ReviseQuoteDraftResult,
  T004GenerateQuoteDraftResult,
  T005CreateSampleShipmentResult,
} from "@weave-order/schema";
import type { T004GenerateQuoteDraftResult as DraftResult } from "@weave-order/schema";
import { AppModule } from "../src/app.module";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * 租户边界与 HTTP 语义验收（真起服务 + 真连 PG）。
 *
 * 覆盖两条铁律的回归：
 *  - 铁律 G4：一条请求 = 一条绑定租户的会话。带凭据的工具 / 审批调用只能看见并写进
 *    凭据自己的租户，演示租户不再是所有 agent 的默认落点；
 *  - 业务失败编码在 body 的 `{ok:false,error}`，状态码同时回到对应 4xx/5xx，
 *    契约校验失败也不再冒泡成 500。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "tenant-boundary-e2e" } };

let app: INestApplication | null = null;
let baseUrl = "";
let db: Db | null = null;
let pool: Pool | null = null;
let available = false;
const createdTenants: string[] = [];

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 3 });
  try {
    const check = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.customers') IS NOT NULL AND to_regclass('public.audit_log') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
  } catch {
    available = false;
  }
  if (!available) return;
  // 库可用却起不来服务 = 装配回归，必须让这条守卫变红，不能退化成 skip。
  db = createDb(DATABASE_URL).db;
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const address = (app.getHttpServer() as Server).address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app?.close();
  if (pool && createdTenants.length > 0) {
    await pool.query("DELETE FROM sample_shipments WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM quote_items WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM quotes WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM customer_contexts WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    // orders.customer_id 是 restrict：必须先清订单，再清客户。
    // 回款流水挂在 receivables 上，也要先清。
    await pool.query("DELETE FROM receivable_payments WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM receivables WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM order_items WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM orders WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM customers WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM sample_embeddings WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM samples WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM memberships WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  }
  await pool?.end();
});

interface HttpResult {
  status: number;
  json: unknown;
}

async function post(path: string, body: unknown, token?: string): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function get(path: string, token?: string): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

/** 一个租户 + 一个 OWNER 成员 + 一套客户 / 面料，返回它的 dev 凭据。 */
async function fixture(label: string) {
  const database = db;
  if (!database) throw new Error("数据库不可用");
  const id = `${label}-${suffix()}`;
  const org = `tb-${id}`;
  const subject = `tb-user-${id}`;
  const bootstrap = createKernel(database);
  const tenant = await bootstrap.tenancy.createTenant(
    { slug: `tb-${id}`, name: `边界租户 ${label}`, casdoorOrg: org },
    SYSTEM,
  );
  createdTenants.push(tenant.id);
  const owner = await bootstrap.tenancy.createMembership(
    { tenantId: tenant.id, subject, casdoorOrg: org, role: "OWNER", dataScope: "ALL" },
    SYSTEM,
  );
  const scoped = createKernel(database, undefined, { tenantId: tenant.id });
  // 客户挂到 OWNER 名下：OWN 范围用例需要一个「同事的客户」当靶子。
  const customer = await scoped.customers.create(
    { code: `TBC-${id}`, name: `边界客户 ${label}` },
    { ...SYSTEM, ownerId: owner.id },
  );
  const sample = await scoped.samples.create(
    {
      code: `TBS-${id}`,
      name: `边界面料 ${label}`,
      unit: "meter",
      costFloor: { amount: 1200, currency: "CNY" },
    },
    SYSTEM,
  );
  return {
    tenantId: tenant.id,
    org,
    scoped,
    customer,
    sample,
    ownerId: owner.id,
    token: `dev:${subject}:${org}`,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** 同租户再加一个成员，返回成员 id 与它的 dev 凭据。 */
async function addMember(f: Fixture, role: "SALES", dataScope: "OWN" | "TEAM" | "ALL") {
  const subject = `tb-${role.toLowerCase()}-${suffix()}`;
  const membership = await f.scoped.tenancy.createMembership(
    { tenantId: f.tenantId, subject, casdoorOrg: f.org, role, dataScope },
    SYSTEM,
  );
  return { id: membership.id, token: `dev:${subject}:${f.org}` };
}

/** 造一个归属指定成员的客户：OWN 范围下只有该成员碰得到。 */
async function addOwnedCustomer(f: Fixture, ownerId: string, label: string) {
  return f.scoped.customers.create(
    { code: `TBK-${label}-${suffix()}`, name: `归属客户 ${label}` },
    { ...SYSTEM, ownerId },
  );
}

const draftPayload = (
  customer: { id: string },
  sample: { id: string },
  unitPrice = 1500,
): Record<string, unknown> => ({
  customerId: customer.id,
  currency: "CNY",
  items: [
    {
      fabricSampleId: sample.id,
      quantity: { value: 10, unit: "meter" },
      unitPrice: { amount: unitPrice, currency: "CNY" },
    },
  ],
});

function drafted(result: DraftResult) {
  if (!result.ok) throw new Error(`期望 ok:true，实际 ${JSON.stringify(result.error)}`);
  return result.data.draft;
}

/** 一张 10 米 × ¥15 = 15000 分的草稿单请求体。 */
const orderPayload = (sample: { id: string }, customer: { id: string }) => ({
  customerId: customer.id,
  code: `ORD-${suffix()}`,
  currency: "CNY",
  items: [
    {
      sampleId: sample.id,
      quantity: { value: 10, unit: "meter" },
      unitPrice: { amount: 1500, currency: "CNY" },
    },
  ],
});

describe("租户边界与 HTTP 语义", () => {
  it("带凭据的工具调用只看得到自己租户：跨租户客户是 404", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const a = await fixture("x-a");
    const b = await fixture("x-b");
    const payload = draftPayload(a.customer, a.sample);

    const crossTenant = await post("/api/tools/generate-quote-draft", payload, b.token);
    expect(crossTenant.status).toBe(404);
    const denied = T004GenerateQuoteDraftResult.parse(crossTenant.json);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("CUSTOMER_NOT_FOUND");

    const own = await post("/api/tools/generate-quote-draft", payload, a.token);
    expect(own.status).toBe(201);
    const draft = drafted(T004GenerateQuoteDraftResult.parse(own.json));
    expect(draft.status).toBe("DRAFT");

    // 落库租户 = 凭据的租户，而不是演示租户。
    const row = await pool?.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM quotes WHERE id = $1",
      [draft.id],
    );
    expect(row?.rows[0]?.tenant_id).toBe(a.tenantId);
  });

  it("写类工具 T-005 同样绑定租户，不再恒定写进演示租户", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const a = await fixture("w-a");
    const b = await fixture("w-b");
    const payload = {
      customerId: a.customer.id,
      items: [{ sampleId: a.sample.id, quantity: { value: 2, unit: "meter" } }],
      channel: "COURIER",
      carrier: "顺丰",
      trackingNumber: `SF${suffix()}`,
    };

    const crossTenant = await post("/api/tools/create-sample-shipment", payload, b.token);
    expect(crossTenant.status).toBe(404);

    const own = await post("/api/tools/create-sample-shipment", payload, a.token);
    expect(own.status).toBe(201);
    const parsed = T005CreateSampleShipmentResult.parse(own.json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const row = await pool?.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM sample_shipments WHERE id = $1",
      [parsed.data.shipment.id],
    );
    expect(row?.rows[0]?.tenant_id).toBe(a.tenantId);
  });

  it("同租户内 OWN 范围驱动 agent：只碰得到自己名下的客户", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const a = await fixture("own-a");
    const sales = await addMember(a, "SALES", "OWN");
    const own = await addOwnedCustomer(a, sales.id, "own");

    // 人类面基线：SALES 只看得到自己名下的那一个客户。
    const list = await get("/api/customers?limit=100", sales.token);
    expect(list.status).toBe(200);
    const visible = (list.json as { customers: Array<{ id: string }> }).customers;
    expect(visible.map((customer) => customer.id)).toEqual([own.id]);

    // 借 agent 越权：建草稿 / 读客户 360 / 建寄样单，一律按「不存在」返回。
    const draft = await post(
      "/api/tools/generate-quote-draft",
      draftPayload(a.customer, a.sample),
      sales.token,
    );
    expect(draft.status).toBe(404);
    const draftResult = T004GenerateQuoteDraftResult.parse(draft.json);
    if (draftResult.ok) throw new Error("OWN 范围不该借 agent 建他人客户的草稿");
    expect(draftResult.error.code).toBe("CUSTOMER_NOT_FOUND");

    const history = await post(
      "/api/tools/get-customer-history",
      { customerId: a.customer.id, limit: 5 },
      sales.token,
    );
    expect(history.status).toBe(404);

    const shipment = await post(
      "/api/tools/create-sample-shipment",
      {
        customerId: a.customer.id,
        items: [{ sampleId: a.sample.id, quantity: { value: 2, unit: "meter" } }],
        channel: "COURIER",
        carrier: "顺丰",
        trackingNumber: `SF${suffix()}`,
      },
      sales.token,
    );
    expect(shipment.status).toBe(404);

    // 自己名下的客户照常可用：守卫不能把功能改死。
    const ownDraft = await post(
      "/api/tools/generate-quote-draft",
      draftPayload(own, a.sample),
      sales.token,
    );
    expect(ownDraft.status).toBe(201);

    const ownHistory = await post(
      "/api/tools/get-customer-history",
      { customerId: own.id, limit: 5 },
      sales.token,
    );
    expect(ownHistory.status).toBe(201);

    // 写入身份仍是 AGENT（铁律：草稿由工具产出），只是可见范围跟人走。
    const audit = await pool?.query<{ actor_type: string }>(
      "SELECT actor_type FROM audit_log WHERE action = 'QUOTE_DRAFT_GENERATED' AND tenant_id = $1 LIMIT 1",
      [a.tenantId],
    );
    expect(audit?.rows[0]?.actor_type).toBe("AGENT");
  });

  it("OWN 范围在订单 / 寄样面同样看不见就改不了", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const a = await fixture("ord-a");
    const sales = await addMember(a, "SALES", "OWN");
    const own = await addOwnedCustomer(a, sales.id, "order");

    // 基线：SALES 读不到同事名下的单，写入也必须一并被挡住（读收口、写裸奔 = 漏洞本体）。
    const byOwner = await post("/api/orders", orderPayload(a.sample, a.customer), a.token);
    expect(byOwner.status).toBe(201);
    const hidden = (byOwner.json as { order: { id: string; code: string } }).order;
    expect((await get(`/api/orders/${hidden.id}`, sales.token)).status).toBe(404);

    const hiddenConfirm = await post(`/api/orders/${hidden.id}/confirm`, {}, sales.token);
    expect(hiddenConfirm.status).toBe(404);
    // 写后读泄漏：确认响应不能把整单内容回吐给看不见它的人。
    expect(JSON.stringify(hiddenConfirm.json)).not.toContain(hidden.code);
    const hiddenRow = await pool?.query<{ status: string; confirmed_by: string | null }>(
      "SELECT status, confirmed_by FROM orders WHERE id = $1",
      [hidden.id],
    );
    expect(hiddenRow?.rows[0]?.status).toBe("DRAFT");
    expect(hiddenRow?.rows[0]?.confirmed_by).toBeNull();

    // 建单入口：越权客户按「不存在」处理，且不落库。
    const foreignOrder = await post("/api/orders", orderPayload(a.sample, a.customer), sales.token);
    expect(foreignOrder.status).toBe(404);
    const foreignRows = await pool?.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orders WHERE customer_id = $1",
      [a.customer.id],
    );
    expect(foreignRows?.rows[0]?.count).toBe("1");

    // 寄样面：审批队列的 decide 不经过 detail() 的可见性闸门，直接打到 confirm。
    const hiddenShipment = await post(
      "/api/tools/create-sample-shipment",
      {
        customerId: a.customer.id,
        items: [{ sampleId: a.sample.id, quantity: { value: 2, unit: "meter" } }],
        channel: "COURIER",
        carrier: "顺丰",
        trackingNumber: `SF${suffix()}`,
      },
      a.token,
    );
    expect(hiddenShipment.status).toBe(201);
    const createdShipment = T005CreateSampleShipmentResult.parse(hiddenShipment.json);
    if (!createdShipment.ok) throw new Error("OWNER 自己建寄样单应当成功");
    const decided = await post(
      "/api/approvals/decide",
      { id: createdShipment.data.shipment.id, kind: "sample_shipment", decision: "APPROVE" },
      sales.token,
    );
    expect(decided.status).toBe(404);
    const shipmentRow = await pool?.query<{ status: string }>(
      "SELECT status FROM sample_shipments WHERE id = $1",
      [createdShipment.data.shipment.id],
    );
    expect(shipmentRow?.rows[0]?.status).toBe("DRAFT");

    // 正向：自己名下的客户照常可建单、可确认，守卫不能把功能改死。
    const mine = await post("/api/orders", orderPayload(a.sample, own), sales.token);
    expect(mine.status).toBe(201);
    const created = (mine.json as { order: { id: string; status: string } }).order;
    expect(created.status).toBe("DRAFT");
    const ownConfirm = await post(`/api/orders/${created.id}/confirm`, {}, sales.token);
    expect(ownConfirm.status).toBe(201);
    expect((ownConfirm.json as { order: { status: string } }).order.status).toBe("CONFIRMED");

    const ownShipment = await post(
      "/api/tools/create-sample-shipment",
      {
        customerId: own.id,
        items: [{ sampleId: a.sample.id, quantity: { value: 2, unit: "meter" } }],
        channel: "COURIER",
        carrier: "顺丰",
        trackingNumber: `SF${suffix()}`,
      },
      sales.token,
    );
    expect(ownShipment.status).toBe(201);
    const ownDraft = T005CreateSampleShipmentResult.parse(ownShipment.json);
    if (!ownDraft.ok) throw new Error("SALES 自己的寄样单应当建成");
    const ownDecided = await post(
      "/api/approvals/decide",
      { id: ownDraft.data.shipment.id, kind: "sample_shipment", decision: "APPROVE" },
      sales.token,
    );
    expect(ownDecided.status).toBe(201);
    expect(ApprovalDecisionResult.parse(ownDecided.json).ok).toBe(true);
  });

  it("OWN 范围碰不到同事订单的应收与收款", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const a = await fixture("recv-a");
    const sales = await addMember(a, "SALES", "OWN");
    const own = await addOwnedCustomer(a, sales.id, "recv");

    // 建单 + 确认各自名下一张：应收必须挂在已确认的订单上。
    const confirmOrder = async (customer: { id: string }, token: string) => {
      const created = await post("/api/orders", orderPayload(a.sample, customer), token);
      expect(created.status).toBe(201);
      const id = (created.json as { order: { id: string } }).order.id;
      expect((await post(`/api/orders/${id}/confirm`, {}, token)).status).toBe(201);
      return id;
    };
    const hiddenOrderId = await confirmOrder(a.customer, a.token);
    const ownOrderId = await confirmOrder(own, sales.token);

    const receivableBody = (orderId: string) => ({
      orderId,
      amount: { amount: 15000, currency: "CNY" },
      dueDate: "2026-12-31T00:00:00.000Z",
    });

    // 越权建应收：订单看不见就不能给它挂账，更不能落库。
    const foreign = await post("/api/receivables", receivableBody(hiddenOrderId), sales.token);
    expect(foreign.status).toBe(404);
    const foreignRows = await pool?.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM receivables WHERE order_id = $1",
      [hiddenOrderId],
    );
    expect(foreignRows?.rows[0]?.count).toBe("0");

    // OWNER 正常挂账后，SALES 既列不到它，也不能替它收款。
    const byOwner = await post("/api/receivables", receivableBody(hiddenOrderId), a.token);
    expect(byOwner.status).toBe(201);
    const hidden = (byOwner.json as { receivable: { id: string } }).receivable;
    const list = await get("/api/receivables?limit=100", sales.token);
    expect(list.status).toBe(200);
    const visible = (list.json as { receivables: Array<{ id: string }> }).receivables;
    expect(visible.map((receivable) => receivable.id)).not.toContain(hidden.id);

    const paid = await post(
      `/api/receivables/${hidden.id}/payments`,
      { amount: { amount: 15000, currency: "CNY" } },
      sales.token,
    );
    expect(paid.status).toBe(404);
    const paidRow = await pool?.query<{ paid_amount: string; status: string }>(
      "SELECT paid_amount, status FROM receivables WHERE id = $1",
      [hidden.id],
    );
    expect(paidRow?.rows[0]?.paid_amount).toBe("0");
    expect(paidRow?.rows[0]?.status).toBe("PENDING");

    // 正向：自己名下的订单照常挂账、照常收款。
    const mine = await post("/api/receivables", receivableBody(ownOrderId), sales.token);
    expect(mine.status).toBe(201);
    const mineId = (mine.json as { receivable: { id: string } }).receivable.id;
    const minePaid = await post(
      `/api/receivables/${mineId}/payments`,
      { amount: { amount: 15000, currency: "CNY" } },
      sales.token,
    );
    expect(minePaid.status).toBe(201);
    expect((minePaid.json as { receivable: { status: string } }).receivable.status).toBe("PAID");
  });

  it("审计流水只回到凭据自己的租户", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const a = await fixture("aud-a");
    const created = await post(
      "/api/tools/generate-quote-draft",
      draftPayload(a.customer, a.sample),
      a.token,
    );
    const quoteId = drafted(T004GenerateQuoteDraftResult.parse(created.json)).id;

    const audit = await get("/api/audit?limit=200", a.token);
    expect(audit.status).toBe(200);
    const entries = (audit.json as { entries: Array<{ entityId: string; tenantId: string }> })
      .entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.entityId === quoteId)).toBe(true);
    for (const entry of entries) {
      expect(entry.tenantId).toBe(a.tenantId);
    }
  });

  it("契约校验失败返回 400 + INVALID_INPUT，而不是 500", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const a = await fixture("zod-a");
    const response = await post("/api/quotes/revise", { quoteId: "not-a-uuid" }, a.token);
    expect(response.status).toBe(400);
    expect((response.json as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
  });

  it("业务失败的状态码回到 4xx：成本底线 422、版本冲突 409", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const a = await fixture("st-a");

    const belowFloor = await post(
      "/api/tools/generate-quote-draft",
      draftPayload(a.customer, a.sample, 1000),
      a.token,
    );
    expect(belowFloor.status).toBe(422);
    const rejected = T004GenerateQuoteDraftResult.parse(belowFloor.json);
    if (rejected.ok) throw new Error("低于成本底线必须返回 ok:false");
    expect(rejected.error).toMatchObject({
      code: "KERNEL_REJECTED",
      reason: "PRICE_BELOW_COST_FLOOR",
    });

    const created = await post(
      "/api/tools/generate-quote-draft",
      draftPayload(a.customer, a.sample),
      a.token,
    );
    const quoteId = drafted(T004GenerateQuoteDraftResult.parse(created.json)).id;

    const revise = (baseVersion: number) =>
      post(
        "/api/quotes/revise",
        {
          quoteId,
          baseVersion,
          source: "INLINE",
          instruction: "单价改 16.00",
          lines: [{ lineIndex: 0, unitPrice: { amount: 1600, currency: "CNY" } }],
        },
        a.token,
      );
    expect((await revise(1)).status).toBe(201);

    const stale = await revise(1);
    expect(stale.status).toBe(409);
    const conflict = ReviseQuoteDraftResult.parse(stale.json);
    if (conflict.ok) throw new Error("过期 baseVersion 必须返回 ok:false");
    expect(conflict.error).toMatchObject({ code: "KERNEL_REJECTED", reason: "VERSION_CONFLICT" });
  });

  it("批准之后仍读得到报价单（状态已离开 DRAFT）", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const a = await fixture("ap-a");
    const created = await post(
      "/api/tools/generate-quote-draft",
      draftPayload(a.customer, a.sample),
      a.token,
    );
    const quoteId = drafted(T004GenerateQuoteDraftResult.parse(created.json)).id;

    const decided = await post(
      "/api/approvals/decide",
      { id: quoteId, kind: "quote", decision: "APPROVE" },
      a.token,
    );
    expect(decided.status).toBe(201);
    expect(ApprovalDecisionResult.parse(decided.json).ok).toBe(true);

    const readBack = await get(`/api/quotes/${quoteId}`, a.token);
    expect(readBack.status).toBe(200);
    const detail = QuoteDetail.parse(readBack.json);
    expect(detail.status).toBe("SENT");
    expect(detail.draft.id).toBe(quoteId);
  });
});
