import "reflect-metadata";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createDb } from "@weave-order/db";
import { PERSONAS } from "@weave-order/schema";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureDemoIdentity, demoWriteContext } from "../src/dev/demo-identity";
import { devPersonasEnabled } from "../src/dev/dev.module";
import { createKernel } from "../src/kernel";

/**
 * dev persona 端点（WAN-136）：
 * - 7 个成员由 `ensureDemoIdentity` 按目录幂等 seed；
 * - `POST /api/dev/session` 只吃 personaKey，服务端重查 membership；
 * - 切换后 `/api/auth/me` 会返回新角色，经理的 TEAM 范围能看到业务员客户；
 * - 非 dev 模式整个模块不进容器（路由 404，而不是 403）。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

let app: INestApplication | null = null;
let baseUrl = "";
let pool: Pool | null = null;
let available = false;
let tenantId = "";
let customerCode = "";
let devImportsContainModule = false;
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

interface AuthBody {
  membership: { role: string; dataScope: string; subject: string };
}

function readCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("weave_sid="));
  const sid = cookie?.split(";")[0]?.slice("weave_sid=".length);
  if (!sid) throw new Error("POST /api/dev/session 没有返回 weave_sid");
  return sid;
}

async function getAuth(sid: string): Promise<AuthBody> {
  const response = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: `weave_sid=${sid}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as AuthBody;
}

async function switchTo(personaKey: string): Promise<Response> {
  return fetch(`${baseUrl}/api/dev/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personaKey }),
  });
}

beforeAll(async () => {
  // AppModule 的 imports 在模块加载时求值，必须在 import 之前把模式定成 dev。
  process.env.NODE_ENV = "test";
  process.env.AUTH_MODE = "dev";
  try {
    const handle = createDb(DATABASE_URL);
    pool = handle.pool;
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.memberships') IS NOT NULL AS exists",
    );
    if (!check.rows[0]?.exists) {
      await handle.pool.end();
      pool = null;
      return;
    }

    const kernel = createKernel(handle.db);
    const tenant = await kernel.tenancy.createTenant(
      { slug: `persona-${suffix()}`, name: "Persona 测试租户", casdoorOrg: "demo" },
      { actor: { type: "SYSTEM", id: "persona-test" } },
    );
    tenantId = tenant.id;
    process.env.SEED_TENANT_ID = tenantId;

    const identity = await ensureDemoIdentity(handle.db);
    customerCode = `E2E-PERSONA-${suffix()}`;
    await createKernel(handle.db, undefined, { tenantId }).customers.create(
      { code: customerCode, name: "业务员名下客户" },
      demoWriteContext(identity, "persona-test"),
    );

    const { AppModule } = await import("../src/app.module");
    const { DevModule: DevModuleInDev } = await import("../src/dev/dev.module");
    devImportsContainModule = (
      (Reflect.getMetadata("imports", AppModule) ?? []) as unknown[]
    ).includes(DevModuleInDev);
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    const address = (app.getHttpServer() as Server).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    available = true;
  } catch (error) {
    console.error("[dev-personas.test] 跳过：", error);
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  if (pool && tenantId) {
    await pool.query(
      "DELETE FROM customer_contexts WHERE customer_id IN (SELECT id FROM customers WHERE tenant_id = $1)",
      [tenantId],
    );
    await pool.query("DELETE FROM customers WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM memberships WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  }
  await pool?.end();
  delete process.env.SEED_TENANT_ID;
});

describe("GET /api/dev/personas", () => {
  it("返回 persona 目录里的全部 7 个角色", async (ctx) => {
    if (!available) return ctx.skip();
    const response = await fetch(`${baseUrl}/api/dev/personas`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { personas: { key: string; role: string }[] };
    expect(body.personas.map((persona) => persona.key)).toEqual(
      PERSONAS.map((persona) => persona.key),
    );
    expect(body.personas.map((persona) => persona.role).sort()).toEqual(
      PERSONAS.map((persona) => persona.role).sort(),
    );
  });
});

describe("POST /api/dev/session", () => {
  it("按 personaKey 换会话，服务端重查 membership", async (ctx) => {
    if (!available) return ctx.skip();
    const response = await switchTo("manager");
    expect(response.status).toBe(200);
    const body = (await response.json()) as AuthBody;
    expect(body.membership).toMatchObject({ role: "MANAGER", dataScope: "TEAM" });

    const sid = readCookie(response);
    expect(await getAuth(sid)).toMatchObject({
      membership: { role: "MANAGER", dataScope: "TEAM", subject: "demo-manager" },
    });
  });

  it("请求体带 role / tenantId 会被 400 拒绝，而不是忽略后继续切换", async (ctx) => {
    if (!available) return ctx.skip();
    for (const extra of [{ role: "OWNER" }, { tenantId }]) {
      const response = await fetch(`${baseUrl}/api/dev/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personaKey: "sales", ...extra }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_INPUT");
    }
  });

  it("经理（TEAM）能看到业务员（OWN）名下的客户", async (ctx) => {
    if (!available) return ctx.skip();

    const salesResponse = await switchTo("sales");
    expect(salesResponse.status).toBe(200);
    const salesSid = readCookie(salesResponse);
    const salesCustomers = (await (
      await fetch(`${baseUrl}/api/auth/customers?limit=100`, {
        headers: { cookie: `weave_sid=${salesSid}` },
      })
    ).json()) as { customers: { code: string }[] };
    expect(salesCustomers.customers.map((customer) => customer.code)).toContain(customerCode);

    const managerResponse = await switchTo("manager");
    const managerSid = readCookie(managerResponse);
    const managerCustomers = (await (
      await fetch(`${baseUrl}/api/auth/customers?limit=100`, {
        headers: { cookie: `weave_sid=${managerSid}` },
      })
    ).json()) as { customers: { code: string }[] };
    expect(managerCustomers.customers.map((customer) => customer.code)).toContain(customerCode);
  });
});

describe("非 dev 模式的注册条件", () => {
  it("oidc / production 下不装配 DevModule（路由 404 的前提）", async () => {
    expect(devImportsContainModule).toBe(true);
    expect(devPersonasEnabled({ NODE_ENV: "development", AUTH_MODE: "dev" })).toBe(true);
    expect(devPersonasEnabled({ NODE_ENV: "test", AUTH_MODE: "oidc" })).toBe(false);
    expect(devPersonasEnabled({ NODE_ENV: "production", AUTH_MODE: "dev" })).toBe(false);

    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      AUTH_MODE: process.env.AUTH_MODE,
    };
    process.env.NODE_ENV = "production";
    process.env.AUTH_MODE = "oidc";
    vi.resetModules();
    try {
      const { AppModule: ProductionAppModule } = await import("../src/app.module");
      const { DevModule } = await import("../src/dev/dev.module");
      const imports = (Reflect.getMetadata("imports", ProductionAppModule) ?? []) as unknown[];
      expect(imports).not.toContain(DevModule);
    } finally {
      if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.NODE_ENV;
      if (previous.AUTH_MODE === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previous.AUTH_MODE;
      vi.resetModules();
    }
  });
});
