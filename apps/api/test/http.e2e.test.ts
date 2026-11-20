import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ImportBatchResult } from "@weave-order/schema";
import { auditLog } from "@weave-order/db";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    expect(await health.json()).toEqual({
      ok: true,
      database: "up",
      // 结构状态与探活同时返回：漏跑迁移是 behind + 缺表名，
      // 表建好但忘授权是 denied + 表名。
      schema: { state: "ok", missing: [], denied: [] },
    });

    const samples = await fetch(`${baseUrl}/api/samples?limit=5`);
    const sampleBody = (await samples.json()) as { samples: unknown[] };
    expect(Array.isArray(sampleBody.samples)).toBe(true);
    expect(sampleBody.samples.length).toBeLessThanOrEqual(5);

    const audit = await fetch(`${baseUrl}/api/audit?limit=3`);
    const auditBody = (await audit.json()) as { entries: unknown[] };
    expect(auditBody.entries.length).toBeLessThanOrEqual(3);
  });

  it("通过 HTTP 走 T-004 生成 DRAFT，确认走 /api/approvals/decide（D1 后确认即定稿）", async (ctx) => {
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
      {
        code: `E2E-S-${suffix}`,
        name: "HTTP 测试面料",
        unit: "meter",
        costFloor: { amount: 1200, currency: "CNY" },
      },
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
    const quoteId = body.data?.draft.id;
    expect(quoteId).toBeDefined();

    // 人类确认统一走审批窗口 decide：状态转 SENT，且 actorType 固定 HUMAN。
    // D1 之后 decide 仍然保留（页面不展示），WAN-197 的事项工作面走
    // POST /api/quotes/:id/confirm，两者落到同一个内核确认逻辑。
    const decide = await fetch(`${baseUrl}/api/approvals/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: quoteId, kind: "quote", decision: "APPROVE" }),
    });
    expect(decide.status).toBe(201);
    const decided = (await decide.json()) as {
      ok: boolean;
      data?: { status: string; actorType: string };
    };
    expect(decided.ok).toBe(true);
    expect(decided.data?.status).toBe("SENT");
    expect(decided.data?.actorType).toBe("HUMAN");
  });

  it("报价确认端点：越权 403 / 不存在 404 / 已确认无幂等键 409 / 同键重放 200", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const kernel = createKernel(database);
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const customer = await kernel.customers.create(
      { code: `E2E-CFM-C-${suffix}`, name: "确认端点客户" },
      HUMAN,
    );
    const sample = await kernel.samples.create(
      {
        code: `E2E-CFM-S-${suffix}`,
        name: "确认端点面料",
        unit: "meter",
        costFloor: { amount: 1200, currency: "CNY" },
      },
      HUMAN,
    );
    const draftResponse = await fetch(`${baseUrl}/api/tools/generate-quote-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId: customer.id,
        currency: "CNY",
        items: [
          {
            fabricSampleId: sample.id,
            quantity: { value: 100, unit: "meter" },
            unitPrice: { amount: 1800, currency: "CNY" },
          },
        ],
      }),
    });
    expect(draftResponse.status).toBe(201);
    const draftBody = (await draftResponse.json()) as {
      ok: boolean;
      data?: { draft: { id: string } };
    };
    const quoteId = draftBody.data?.draft.id;
    expect(quoteId).toBeDefined();

    const confirmAs = (authorization: string | null, body: unknown) =>
      fetch(`${baseUrl}/api/quotes/${quoteId}/confirm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify(body),
      });

    // 未授权角色：SALES 没有 quote.confirm，必须是 403 而不是 500。
    const sales = await confirmAs("Bearer dev:demo-sales:demo", {});
    expect(sales.status, await sales.text()).toBe(403);

    // 报价不存在：404。
    const missing = await fetch(`${baseUrl}/api/quotes/${randomUUID()}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(404);

    const idempotencyKey = `http-confirm-${suffix}`;
    const first = await confirmAs(null, { idempotencyKey });
    const firstText = await first.text();
    expect(first.status, firstText).toBe(200);
    const firstBody = JSON.parse(firstText) as Record<string, unknown>;
    expect(firstBody.status).toBe("SENT");

    // 同一个 key 是重试：200 且 body 相同。
    const replay = await confirmAs(null, { idempotencyKey });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    // 已确认后无 key 再确认不是「重试」，是状态冲突：409。
    const noKey = await confirmAs(null, {});
    expect(noKey.status).toBe(409);

    // 已确认后换一个 key 也不是重试：409。
    const otherKey = await confirmAs(null, { idempotencyKey: `${idempotencyKey}-2` });
    expect(otherKey.status).toBe(409);
  }, 30_000);

  it("HTTP 复测：100%棉 按字面量匹配，matchedOn 非空", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const kernel = createKernel(database);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const sample = await kernel.samples.create(
      { code: `E2E-LIKE-${id}`, name: "100%棉HTTP回归布", unit: "meter" },
      HUMAN,
    );

    const response = await fetch(`${baseUrl}/api/tools/search-by-spec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "100%棉", limit: 100 }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      data?: {
        matches: {
          sample: { id: string; name: string };
          matchedOn: string[];
          score: number;
        }[];
      };
    };
    expect(body.ok).toBe(true);
    const matches = body.data?.matches ?? [];
    expect(matches.map((match) => match.sample.id)).toContain(sample.id);
    for (const match of matches) {
      expect(match.matchedOn.length).toBeGreaterThan(0);
      expect(match.sample.name.toLowerCase()).toContain("100%棉");
    }
  });

  it("POST /api/import：冷启动导入整批落库，审计固定 HUMAN 上下文", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const code = `E2E-IMP-C-${suffix}`;
    const sampleCode = `E2E-IMP-S-${suffix}`;
    const response = await fetch(`${baseUrl}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customers: [{ code, name: "HTTP 导入客户" }],
        samples: [
          {
            code: sampleCode,
            name: "HTTP 导入面料",
            unit: "meter",
            costFloor: { amount: 1200, currency: "CNY" },
          },
        ],
      }),
    });
    expect(response.status).toBe(201);
    const result = ImportBatchResult.parse(await response.json());
    expect(result.committed).toBe(true);
    expect(result.importedCustomers).toBe(1);
    expect(result.importedSamples).toBe(1);
    expect(result.correlationId).not.toBeNull();

    const entries = await database
      .select()
      .from(auditLog)
      .where(eq(auditLog.correlationId, result.correlationId ?? ""));
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.actorType === "HUMAN")).toBe(true);
  });

  it("POST /api/import：坏行整批拒绝、零写入（HTTP 面同样可判别）", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const response = await fetch(`${baseUrl}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customers: [{ code: "", name: "", tier: "MADE_UP" }],
        samples: [],
      }),
    });
    expect(response.status).toBe(201);
    const result = ImportBatchResult.parse(await response.json());
    expect(result.committed).toBe(false);
    expect(result.batchError?.code).toBe("BATCH_REJECTED");
    expect(result.importedCustomers).toBe(0);
  });

  it("POST /api/customers：不填编号由服务端生成，重复编号返回 409 + 可判别 code", async (ctx) => {
    if (!available) ctx.skip();
    const created = await fetch(`${baseUrl}/api/customers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `HTTP 新客户 ${Date.now().toString(36)}`, tier: "NEW" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      customer: { id: string; code: string; name: string };
    };
    expect(body.customer.id).toBeTruthy();
    expect(body.customer.code).toMatch(/^C\d{6}-\d{4,}$/);

    const code = `E2E-HUMAN-C-${Date.now().toString(36)}`;
    const first = await fetch(`${baseUrl}/api/customers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "显式编号客户" }),
    });
    expect(first.status).toBe(201);

    const duplicate = await fetch(`${baseUrl}/api/customers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "重复编号客户" }),
    });
    expect(duplicate.status).toBe(409);
    const duplicateBody = (await duplicate.json()) as { error?: { code?: string } };
    if (duplicateBody.error) expect(duplicateBody.error.code).toBe("CUSTOMER_CODE_EXISTS");
  });

  it("参数匹配工具走 HTTP，非法输入返回 400 + INVALID_INPUT 而不是 500", async (ctx) => {
    if (!available) ctx.skip();
    const response = await fetch(`${baseUrl}/api/tools/search-by-spec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("INVALID_INPUT");
  });
});
