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
let subjectA = "";
let orgA = "";
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
    };
    expect(body.subject).toBe(subjectA);
    expect(body.tenant.id).toBe(tenantA);
    expect(body.membership.role).toBe("OWNER");
  });

  it("org 与本地 membership 不一致 → 403", async (ctx) => {
    if (!available) ctx.skip();
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer dev:${subjectA}:other-org` },
    });
    expect(response.status).toBe(403);
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
