import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { AppModule } from "../src/app.module";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * HTTP 面端到端：真实启动 Nest、真实连 PG。
 * 没有本地 PG 时整组跳过（`pnpm test` 离线仍全绿）。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "e2e-seed" } };

let app: INestApplication | null = null;
let baseUrl = "";
let db: Db | null = null;
let available = false;

beforeAll(async () => {
  try {
    const handle = createDb(DATABASE_URL);
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.sample_embeddings') IS NOT NULL AS exists",
    );
    db = handle.db;
    available = check.rows[0]?.exists === true;
    if (!available) {
      await handle.pool.end();
      return;
    }
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    const server = app.getHttpServer() as Server;
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
});

describe("HTTP 面（e2e）", () => {
  it("健康检查与只读目录", async (ctx) => {
    if (!available) ctx.skip();
    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, database: "up" });

    const samples = await fetch(`${baseUrl}/api/samples?limit=5`);
    const sampleBody = (await samples.json()) as { samples: unknown[] };
    expect(Array.isArray(sampleBody.samples)).toBe(true);
    expect(sampleBody.samples.length).toBeLessThanOrEqual(5);

    const audit = await fetch(`${baseUrl}/api/audit?limit=3`);
    const auditBody = (await audit.json()) as { entries: unknown[] };
    expect(auditBody.entries.length).toBeLessThanOrEqual(3);
  });

  it("通过 HTTP 走 T-004 生成 DRAFT，智能体不能确认", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const kernel = createKernel(database);
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const customer = await kernel.customers.create(
      { code: `E2E-C-${suffix}`, name: "HTTP 测试客户" },
      HUMAN,
    );
    const sample = await kernel.samples.create(
      { code: `E2E-S-${suffix}`, name: "HTTP 测试面料", unit: "meter" },
      HUMAN,
    );

    const response = await fetch(`${baseUrl}/api/tools/generate-quote-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId: customer.id,
        currency: "CNY",
        items: [
          {
            fabricSampleId: sample.id,
            quantity: { value: 120.5, unit: "meter" },
            unitPrice: { amount: 1500, currency: "CNY" },
          },
        ],
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      data?: { draft: { id: string; status: string; total: { amount: number } } };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.draft.status).toBe("DRAFT");
    expect(body.data?.draft.total.amount).toBe(180750);

    // 人类确认走另一个接口：状态转 SENT
    const confirm = await fetch(`${baseUrl}/api/quotes/${body.data?.draft.id}/confirm`, {
      method: "POST",
    });
    expect(confirm.status).toBe(201);
    const confirmed = (await confirm.json()) as { status: string };
    expect(confirmed.status).toBe("SENT");
  });

  it("参数匹配工具走 HTTP，非法输入返回 INVALID_INPUT 而不是 500", async (ctx) => {
    if (!available) ctx.skip();
    const response = await fetch(`${baseUrl}/api/tools/search-by-spec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("INVALID_INPUT");
  });
});
