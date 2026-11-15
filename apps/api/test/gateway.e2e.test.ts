import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createDb } from "@weave-order/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * 网关端到端：dev 令牌 → (sub, org) → 本地 membership → 租户上下文。
 * 同时验证 `/api/auth/customers` 只返回该租户的数据。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "e2e-gateway" } };
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "e2e-gateway-human" } };

let app: INestApplication | null = null;
let baseUrl = "";
let pool: Pool | null = null;
let available = false;
let tenantA = "";
let tenantB = "";
let subjectA = "";
let orgA = "";
/** 一个账号两个租户：多公司顾问场景。 */
let multiSubject = "";
const createdTenants: string[] = [];
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  try {
    const handle = createDb(DATABASE_URL);
    pool = handle.pool;
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.memberships') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (!available) {
      await handle.pool.end();
      return;
    }

    const bootstrap = createKernel(handle.db);
    const a = await bootstrap.tenancy.createTenant(
      { slug: `gw-a-${suffix()}`, name: "网关租户 A", casdoorOrg: "gw-org-a" },
      SYSTEM,
    );
    const b = await bootstrap.tenancy.createTenant(
      { slug: `gw-b-${suffix()}`, name: "网关租户 B", casdoorOrg: "gw-org-b" },
      SYSTEM,
    );
    tenantA = a.id;
    orgA = "gw-org-a";
    subjectA = `gw-user-${suffix()}`;
    createdTenants.push(a.id, b.id);
    await bootstrap.tenancy.createMembership(
      {
        tenantId: a.id,
        subject: subjectA,
        casdoorOrg: orgA,
        role: "OWNER",
        dataScope: "ALL",
      },
      SYSTEM,
    );

    await createKernel(handle.db, undefined, { tenantId: a.id }).customers.create(
      { code: `GW-A-${suffix()}`, name: "只属于 A 的客户" },
      HUMAN,
    );
    await createKernel(handle.db, undefined, { tenantId: b.id }).customers.create(
      { code: `GW-B-${suffix()}`, name: "只属于 B 的客户" },
      HUMAN,
    );

    // 同一个 subject 在两个租户都有 ACTIVE membership。
    tenantB = b.id;
    multiSubject = `gw-multi-${suffix()}`;
    await bootstrap.tenancy.createMembership(
      {
        tenantId: a.id,
        subject: multiSubject,
        casdoorOrg: "gw-org-a",
        role: "SALES",
        dataScope: "ALL",
      },
      SYSTEM,
    );
    await bootstrap.tenancy.createMembership(
      {
        tenantId: b.id,
        subject: multiSubject,
        casdoorOrg: "gw-org-b",
        role: "FINANCE",
        dataScope: "ALL",
      },
      SYSTEM,
    );

    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    const address = (app.getHttpServer() as Server).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  if (pool && createdTenants.length > 0) {
    const client = pool;
    for (const table of [
      "quote_items",
      "quotes",
      "sample_shipment_items",
      "sample_shipments",
      "customer_contexts",
      "customers",
      "samples",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [
        createdTenants,
      ]);
    }
    await client.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  }
});

describe("网关（dev 令牌 + 租户上下文）", () => {
  it("无令牌 → 401 + 统一错误契约", async (ctx) => {
    if (!available) ctx.skip();
    const response = await fetch(`${baseUrl}/api/auth/me`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  it("令牌 → membership → /auth/me 返回租户与角色", async (ctx) => {
    if (!available) ctx.skip();
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer dev:${subjectA}:${orgA}` },
    });
    const raw = await response.text();
    expect(response.status, raw).toBe(200);
    const body = JSON.parse(raw) as {
      subject: string;
      tenant: { id: string };
      membership: { role: string; dataScope: string };
      capabilities: string[];
    };
    expect(body.subject).toBe(subjectA);
    expect(body.tenant.id).toBe(tenantA);
    expect(body.membership.role).toBe("OWNER");
    // 能力由服务端按 packages/schema 的权限表算好，OWNER 拥有全部能力。
    expect(body.capabilities).toEqual(
      expect.arrayContaining([
        "sample.write",
        "sample.cost.view",
        "quote.approve",
        "panorama.orders.view",
        "member.invite",
        "settings.edit",
      ]),
    );
  });

  it("org 与本地 membership 不一致 → 403", async (ctx) => {
    if (!available) ctx.skip();
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer dev:${subjectA}:other-org` },
    });
    expect(response.status).toBe(403);
  });

  it("多租户账号登录 → 选择列表 → 切换租户（会话 + 审计 + RLS）", async (ctx) => {
    if (!available) ctx.skip();
    // 1) 首次 me：不是拒绝登录，而是返回该账号自己的两家公司。
    const first = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer dev:${multiSubject}:gw-org-a` },
    });
    const firstRaw = await first.text();
    expect(first.status, firstRaw).toBe(200);
    const choices = JSON.parse(firstRaw) as {
      status: string;
      tenants: { tenantId: string; name: string; role: string | null }[];
    };
    expect(choices.status).toBe("MULTI_TENANT");
    expect(choices.tenants.map((entry) => entry.tenantId).sort()).toEqual(
      [tenantA, tenantB].sort(),
    );

    const sidCookie = first.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .find((value) => value.startsWith("weave_sid="));
    expect(sidCookie).toBeTruthy();
    expect(choices.tenants.some((entry) => entry.name.includes("网关租户"))).toBe(true);

    // 2) 选中 A：返回绑定上下文，并换一把新 sid（防会话固定）。
    const picked = await fetch(`${baseUrl}/api/auth/switch`, {
      method: "POST",
      headers: { cookie: sidCookie as string, "content-type": "application/json" },
      body: JSON.stringify({ tenantId: tenantA }),
    });
    const pickedRaw = await picked.text();
    expect(picked.status, pickedRaw).toBe(200);
    const context = JSON.parse(pickedRaw) as {
      tenant: { id: string };
      membership: { role: string };
    };
    expect(context.tenant.id).toBe(tenantA);
    expect(context.membership.role).toBe("SALES");
    const nextCookie = picked.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .find((value) => value.startsWith("weave_sid="));
    expect(nextCookie).toBeTruthy();
    expect(nextCookie).not.toBe(sidCookie);

    // 3) 业务端点只看得见所选租户的数据。
    const customersA = await fetch(`${baseUrl}/api/auth/customers?limit=100`, {
      headers: { cookie: nextCookie as string },
    });
    const customersARaw = await customersA.text();
    expect(customersA.status, customersARaw).toBe(200);
    const listA = JSON.parse(customersARaw) as { tenantId: string; customers: { name: string }[] };
    expect(listA.tenantId).toBe(tenantA);
    expect(listA.customers.some((row) => row.name === "只属于 B 的客户")).toBe(false);

    // 4) 切到 B：角色随租户变，数据也换。
    const switched = await fetch(`${baseUrl}/api/auth/switch`, {
      method: "POST",
      headers: { cookie: nextCookie as string, "content-type": "application/json" },
      body: JSON.stringify({ tenantId: tenantB }),
    });
    const switchedRaw = await switched.text();
    expect(switched.status, switchedRaw).toBe(200);
    const contextB = JSON.parse(switchedRaw) as {
      tenant: { id: string };
      membership: { role: string };
    };
    expect(contextB.tenant.id).toBe(tenantB);
    expect(contextB.membership.role).toBe("FINANCE");
    const cookieB = switched.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .find((value) => value.startsWith("weave_sid="));
    const customersB = await fetch(`${baseUrl}/api/auth/customers?limit=100`, {
      headers: { cookie: cookieB as string },
    });
    const listB = (await customersB.json()) as { tenantId: string; customers: { name: string }[] };
    expect(listB.tenantId).toBe(tenantB);
    expect(listB.customers.some((row) => row.name === "只属于 A 的客户")).toBe(false);

    // 5) 审计：每次切换落 to 租户一条 TENANT_SWITCHED。
    const audit = await pool!.query<{
      before: { fromTenantId: string | null };
      after: { toTenantId: string };
    }>(
      "SELECT before, after FROM audit_log WHERE tenant_id = $1 AND action = 'TENANT_SWITCHED' ORDER BY seq",
      [tenantB],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0]?.after.toTenantId).toBe(tenantB);
    expect(audit.rows[0]?.before.fromTenantId).toBe(tenantA);
  });

  it("切换到自己没有的租户 → 403，且不泄露租户存在性", async (ctx) => {
    if (!available) ctx.skip();
    const login = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer dev:${multiSubject}:gw-org-a` },
    });
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .find((value) => value.startsWith("weave_sid=")) as string;
    const denied = await fetch(`${baseUrl}/api/auth/switch`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "00000000-0000-4000-8000-000000000000" }),
    });
    const deniedRaw = await denied.text();
    expect(denied.status, deniedRaw).toBe(403);
    const body = JSON.parse(deniedRaw) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("TENANT_UNAVAILABLE");
    expect(body.error.message).not.toContain("不存在");
  });

  it("业务端点只返回当前租户数据", async (ctx) => {
    if (!available) ctx.skip();
    const response = await fetch(`${baseUrl}/api/auth/customers?limit=100`, {
      headers: { authorization: `Bearer dev:${subjectA}:${orgA}` },
    });
    const raw = await response.text();
    expect(response.status, raw).toBe(200);
    const body = JSON.parse(raw) as {
      tenantId: string;
      customers: { tenantId: string; name: string }[];
    };
    expect(body.tenantId).toBe(tenantA);
    expect(body.customers.length).toBeGreaterThan(0);
    expect(body.customers.every((row) => row.tenantId === tenantA)).toBe(true);
    expect(body.customers.some((row) => row.name === "只属于 B 的客户")).toBe(false);
  });
});
