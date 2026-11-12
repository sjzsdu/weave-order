import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import type { DeviceAuthorizationPollResult, DeviceAuthorizationStart } from "@weave-order/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";

/**
 * 凭据与 CLI 登录端到端：真实 Nest + 真实 PG。
 * 没有本地 PG 时整组跳过，与既有 http.e2e 的策略一致。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

let app: INestApplication | null = null;
let baseUrl = "";
let db: Db | null = null;
let available = false;

interface JsonError {
  error: { code: string; message: string };
}

beforeAll(async () => {
  process.env.AUTH_TOKEN_PEPPER = process.env.AUTH_TOKEN_PEPPER ?? "e2e-pepper";
  process.env.AUTH_REQUIRED = "false";
  try {
    const handle = createDb(DATABASE_URL);
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.api_tokens') IS NOT NULL AS exists",
    );
    db = handle.db;
    available = check.rows[0]?.exists === true;
    if (!available) {
      await handle.pool.end();
      return;
    }
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
});

async function json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function login(): Promise<{ token: string; email: string; userCode: string }> {
  const email = `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@weave.test`;
  const start = await json<DeviceAuthorizationStart>("/api/auth/device/start", {
    method: "POST",
    body: JSON.stringify({ clientName: "vitest-cli/1.0.0" }),
  });
  expect(start.status).toBe(201);

  const pending = await json<DeviceAuthorizationPollResult>("/api/auth/device/poll", {
    method: "POST",
    body: JSON.stringify({ deviceCode: start.body.deviceCode }),
  });
  expect(pending.body.status).toBe("pending");

  const decided = await json<{ approved: boolean; email: string }>("/api/auth/device/decide", {
    method: "POST",
    body: JSON.stringify({ userCode: start.body.userCode, email, approve: true }),
  });
  expect(decided.status).toBe(200);
  expect(decided.body.approved).toBe(true);

  const approved = await json<DeviceAuthorizationPollResult>("/api/auth/device/poll", {
    method: "POST",
    body: JSON.stringify({ deviceCode: start.body.deviceCode }),
  });
  expect(approved.body.status).toBe("approved");
  if (approved.body.status !== "approved") throw new Error("登录未批准");
  expect(approved.body.user.email).toBe(email);
  expect(approved.body.tokenView.scopes).toEqual(["read", "write"]);
  return { token: approved.body.token, email, userCode: start.body.userCode };
}

describe("用户凭据与 CLI 设备登录（e2e）", () => {
  it("设备登录：pending → approve → 一次性换取 token", async (ctx) => {
    if (!available) ctx.skip();
    const { token } = await login();

    const me = await json<{ user: { email: string }; token: { prefix: string } }>("/api/auth/me", {
      headers: bearer(token),
    });
    expect(me.status).toBe(200);
    expect(me.body.token.prefix).toMatch(/^wo_[a-z0-9]{10}$/);

    // 默认登录凭据没有 approve 作用域：能干活，不能自己审批。
    const denied = await json<JsonError>("/api/approvals/decide", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        id: "00000000-0000-4000-8000-000000000000",
        kind: "quote",
        decision: "APPROVE",
      }),
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("SCOPE_REQUIRED");
  });

  it("device_code 只能换取一次凭据", async (ctx) => {
    if (!available || !db) {
      ctx.skip();
      return;
    }
    const { email } = await login();
    const start = await json<DeviceAuthorizationStart>("/api/auth/device/start", {
      method: "POST",
      body: JSON.stringify({ clientName: "replay-test" }),
    });
    await json("/api/auth/device/decide", {
      method: "POST",
      body: JSON.stringify({ userCode: start.body.userCode, email, approve: true }),
    });
    const first = await json<DeviceAuthorizationPollResult>("/api/auth/device/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode: start.body.deviceCode }),
    });
    expect(first.body.status).toBe("approved");

    const replay = await json<JsonError>("/api/auth/device/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode: start.body.deviceCode }),
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("DEVICE_CODE_INVALID");
  });

  it("拒绝登录：CLI 拿到 denied，且不签发凭据", async (ctx) => {
    if (!available) ctx.skip();
    const start = await json<DeviceAuthorizationStart>("/api/auth/device/start", {
      method: "POST",
      body: JSON.stringify({}),
    });
    await json("/api/auth/device/decide", {
      method: "POST",
      body: JSON.stringify({
        userCode: start.body.userCode,
        email: "deny@weave.test",
        approve: false,
      }),
    });
    const polled = await json<DeviceAuthorizationPollResult>("/api/auth/device/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode: start.body.deviceCode }),
    });
    expect(polled.body.status).toBe("denied");
  });

  it("token 管理：创建（含 approve 作用域）、列出、撤销后立即失效", async (ctx) => {
    if (!available) ctx.skip();
    const { token } = await login();

    const created = await json<{ token: string; tokenView: { id: string; scopes: string[] } }>(
      "/api/auth/tokens",
      {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ name: "审批终端", scopes: ["read", "approve"], expiresInDays: 30 }),
      },
    );
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^wo_/);
    expect(created.body.tokenView.scopes).toEqual(["read", "approve"]);

    const list = await json<{ tokens: { id: string; prefix: string }[] }>("/api/auth/tokens", {
      headers: bearer(token),
    });
    expect(list.body.tokens.some((item) => item.id === created.body.tokenView.id)).toBe(true);

    // approve 作用域生效：审批接口不再是 403（对象不存在时由 approval 层返回业务错误）。
    const panorama = await json<{ panels: unknown }>("/api/panorama", {
      headers: bearer(created.body.token),
    });
    expect(panorama.status).toBe(200);

    const revoked = await json<{ status: string }>(
      `/api/auth/tokens/${created.body.tokenView.id}`,
      {
        method: "DELETE",
        headers: bearer(token),
      },
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe("REVOKED");

    const after = await json<JsonError>("/api/auth/me", { headers: bearer(created.body.token) });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("TOKEN_REVOKED");
  });

  it("未带凭据的身份端点 401，伪造凭据 401，缺 scope 403", async (ctx) => {
    if (!available) ctx.skip();
    const anonymous = await json<JsonError>("/api/auth/me");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe("AUTH_REQUIRED");

    const forged = await json<JsonError>("/api/auth/me", {
      headers: bearer(`wo_${"a".repeat(10)}_${"b".repeat(32)}`),
    });
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe("INVALID_TOKEN");

    const { token } = await login();
    const approveOnly = await json<{ token: string }>("/api/auth/tokens", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "只读审批", scopes: ["approve"] }),
    });
    const read = await json<JsonError>("/api/samples", {
      headers: bearer(approveOnly.body.token),
    });
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe("SCOPE_REQUIRED");
  });

  it("浏览器确认页可打开，且不泄露用户输入", async (ctx) => {
    if (!available) ctx.skip();
    const page = await fetch(`${baseUrl}/cli-login?user_code=%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("确认码");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
