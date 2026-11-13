import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createDb } from "@weave-order/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  DeviceAuthorizationPollResult,
  DeviceAuthorizationStart,
  PersonalAccessIdentity,
} from "@weave-order/schema";
import { AppModule } from "../src/app.module";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * 个人访问凭据 + CLI 设备登录端到端（WAN-78）。
 *
 * 使用网关的 dev 令牌（`dev:<sub>:<org>`）模拟「已登录的人类」：
 * 设备登录批准必须带登录态，凭据绑定到该成员的 membership，
 * 之后 PAT 认证走同一条 membership → tenant → RLS 链路。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "e2e-pat" } };

let app: INestApplication | null = null;
let baseUrl = "";
let pool: Pool | null = null;
let available = false;
let tenantId = "";
let subject = "";
let org = "";
const createdTenants: string[] = [];
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

interface JsonError {
  error: { code: string; message: string };
}

beforeAll(async () => {
  try {
    const handle = createDb(DATABASE_URL);
    pool = handle.pool;
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.api_tokens') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (!available) {
      await handle.pool.end();
      return;
    }

    const bootstrap = createKernel(handle.db);
    org = `pat-org-${suffix()}`;
    const tenant = await bootstrap.tenancy.createTenant(
      { slug: `pat-${suffix()}`, name: "PAT 租户", casdoorOrg: org },
      SYSTEM,
    );
    tenantId = tenant.id;
    subject = `pat-user-${suffix()}`;
    createdTenants.push(tenant.id);
    await bootstrap.tenancy.createMembership(
      { tenantId: tenant.id, subject, casdoorOrg: org, role: "OWNER", dataScope: "ALL" },
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
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  }
});

async function call<T>(
  path: string,
  init: RequestInit & { authorization?: string } = {},
): Promise<{ status: number; body: T }> {
  const { authorization, ...rest } = init;
  const response = await fetch(`${baseUrl}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = (text ? JSON.parse(text) : undefined) as T;
  return { status: response.status, body };
}

const devToken = () => `dev:${subject}:${org}`;

async function deviceLogin(scopes?: string[]): Promise<{ token: string; userCode: string }> {
  const start = await call<DeviceAuthorizationStart>("/api/auth/device/start", {
    method: "POST",
    body: JSON.stringify({ clientName: "vitest-cli/1.0.0" }),
  });
  expect(start.status).toBe(201);

  const pending = await call<DeviceAuthorizationPollResult>("/api/auth/device/poll", {
    method: "POST",
    body: JSON.stringify({ deviceCode: start.body.deviceCode }),
  });
  expect(pending.body.status).toBe("pending");

  const decided = await call<{ approved: boolean; subject: string }>("/api/auth/device/decide", {
    method: "POST",
    authorization: devToken(),
    body: JSON.stringify({
      userCode: start.body.userCode,
      approve: true,
      ...(scopes ? { scopes } : {}),
    }),
  });
  expect(decided.status).toBe(200);
  expect(decided.body.approved).toBe(true);
  expect(decided.body.subject).toBe(subject);

  const approved = await call<DeviceAuthorizationPollResult>("/api/auth/device/poll", {
    method: "POST",
    body: JSON.stringify({ deviceCode: start.body.deviceCode }),
  });
  expect(approved.body.status).toBe("approved");
  if (approved.body.status !== "approved") throw new Error("登录未批准");
  expect(approved.body.membership.id).toBeTypeOf("string");
  expect(approved.body.tenant.id).toBe(tenantId);
  return { token: approved.body.token, userCode: start.body.userCode };
}

describe("个人访问凭据与 CLI 设备登录（e2e）", () => {
  it("设备登录：pending → 人类批准 → 一次性换取 token → whoami 带租户", async (ctx) => {
    if (!available) ctx.skip();
    const { token } = await deviceLogin();

    const who = await call<PersonalAccessIdentity>("/api/auth/whoami", {
      authorization: token,
    });
    expect(who.status).toBe(200);
    expect(who.body.subject).toBe(subject);
    expect(who.body.tenant.id).toBe(tenantId);
    expect(who.body.membership.role).toBe("OWNER");
    expect(who.body.token?.scopes).toEqual(["read", "write"]);

    // 网关的 /auth/me 也接受 PAT：同一套 membership 解析。
    const me = await call<{ subject: string; tenant: { id: string } }>("/api/auth/me", {
      authorization: token,
    });
    expect(me.status).toBe(200);
    expect(me.body.subject).toBe(subject);
    expect(me.body.tenant.id).toBe(tenantId);
  });

  it("device_code 只能换取一次凭据", async (ctx) => {
    if (!available) ctx.skip();
    // 手动走一遍，保留 deviceCode 用于重放。
    const start = await call<DeviceAuthorizationStart>("/api/auth/device/start", {
      method: "POST",
      body: JSON.stringify({ clientName: "replay-test" }),
    });
    await call("/api/auth/device/decide", {
      method: "POST",
      authorization: devToken(),
      body: JSON.stringify({ userCode: start.body.userCode, approve: true }),
    });
    const first = await call<DeviceAuthorizationPollResult>("/api/auth/device/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode: start.body.deviceCode }),
    });
    expect(first.body.status).toBe("approved");

    const replay = await call<JsonError>("/api/auth/device/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode: start.body.deviceCode }),
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("DEVICE_CODE_INVALID");
  });

  it("拒绝登录：CLI 拿到 denied，且不签发凭据", async (ctx) => {
    if (!available) ctx.skip();
    const start = await call<DeviceAuthorizationStart>("/api/auth/device/start", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const denied = await call<{ approved: boolean }>("/api/auth/device/decide", {
      method: "POST",
      authorization: devToken(),
      body: JSON.stringify({ userCode: start.body.userCode, approve: false }),
    });
    expect(denied.status).toBe(200);
    expect(denied.body.approved).toBe(false);

    const polled = await call<DeviceAuthorizationPollResult>("/api/auth/device/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode: start.body.deviceCode }),
    });
    expect(polled.body.status).toBe("denied");
  });

  it("设备登录批准必须带登录态", async (ctx) => {
    if (!available) ctx.skip();
    const start = await call<DeviceAuthorizationStart>("/api/auth/device/start", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const anonymous = await call<JsonError>("/api/auth/device/decide", {
      method: "POST",
      body: JSON.stringify({ userCode: start.body.userCode, approve: true }),
    });
    expect(anonymous.status).toBe(401);
  });

  it("默认凭据不能审批；approve 需人类显式签发", async (ctx) => {
    if (!available) ctx.skip();
    const { token } = await deviceLogin();

    // read/write 凭据调用审批 → 403 SCOPE_REQUIRED（HumanActorService 收口）。
    const blocked = await call<JsonError>("/api/approvals/decide", {
      method: "POST",
      authorization: token,
      body: JSON.stringify({
        id: "00000000-0000-4000-8000-000000000000",
        kind: "quote",
        decision: "APPROVE",
      }),
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("SCOPE_REQUIRED");

    // 低权凭据也不能给自己签发 approve。
    const escalate = await call<JsonError>("/api/auth/tokens", {
      method: "POST",
      authorization: token,
      body: JSON.stringify({ name: "越权", scopes: ["read", "approve"] }),
    });
    expect(escalate.status).toBe(403);

    // 人类 OIDC 会话可以签发 approve。
    const created = await call<{ token: string; tokenView: { scopes: string[] } }>(
      "/api/auth/tokens",
      {
        method: "POST",
        authorization: devToken(),
        body: JSON.stringify({ name: "审批终端", scopes: ["read", "approve"], expiresInDays: 30 }),
      },
    );
    expect(created.status).toBe(201);
    expect(created.body.tokenView.scopes).toEqual(["read", "approve"]);

    // 带 approve 的凭据：审批不再被作用域拦截（对象不存在时返回业务错误）。
    const decide = await call<{ ok?: boolean; error?: { code?: string } }>(
      "/api/approvals/decide",
      {
        method: "POST",
        authorization: created.body.token,
        body: JSON.stringify({
          id: "00000000-0000-4000-8000-000000000000",
          kind: "quote",
          decision: "APPROVE",
        }),
      },
    );
    expect(decide.body.error?.code).not.toBe("SCOPE_REQUIRED");
  });

  it("token 管理：列出、撤销后立即失效", async (ctx) => {
    if (!available) ctx.skip();
    const { token } = await deviceLogin();

    const list = await call<{ tokens: { id: string; prefix: string }[] }>("/api/auth/tokens", {
      authorization: token,
    });
    expect(list.status).toBe(200);
    expect(list.body.tokens.length).toBeGreaterThan(0);

    const own = list.body.tokens[0];
    expect(own).toBeDefined();
    const revoked = await call<{ status: string }>(`/api/auth/tokens/${own?.id}`, {
      method: "DELETE",
      authorization: token,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe("REVOKED");

    const after = await call<JsonError>("/api/auth/whoami", { authorization: token });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("TOKEN_REVOKED");
  });

  it("伪造凭据 401；健康检查不受影响", async (ctx) => {
    if (!available) ctx.skip();
    const forged = await call<JsonError>("/api/auth/whoami", {
      authorization: `wo_${"a".repeat(10)}_${"b".repeat(32)}`,
    });
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe("INVALID_TOKEN");

    const health = await call<{ ok: boolean }>("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
  });
});
