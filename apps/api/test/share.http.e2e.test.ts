import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

/**
 * 客户报价链接的 HTTP 面：真起 Nest、真连 PG。
 * 重点验证公开路由的 HTTP 语义（404 / 410 / 400）与「业务员生成 → 客户查看」闭环。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "e3-http-human" } };
const AGENT: KernelContext = { actor: { type: "AGENT", id: "e3-http-agent" } };

let app: INestApplication | null = null;
let baseUrl = "";
let db: Db | null = null;
let available = false;

beforeAll(async () => {
  try {
    const handle = createDb(DATABASE_URL);
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.quote_shares') IS NOT NULL AS exists",
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

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function approvedQuote(kernel: Kernel): Promise<string> {
  const id = suffix();
  const customer = await kernel.customers.create(
    { code: `E3H-C-${id}`, name: "上海云锦贸易", contactPhone: "13900001234" },
    HUMAN,
  );
  const sample = await kernel.samples.create(
    { code: `E3H-S-${id}`, name: "亚麻混纺 180g", unit: "meter" },
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
          quantity: { value: 200, unit: "meter" },
          unitPrice: { amount: 2850, currency: "CNY" },
        },
      ],
    },
    AGENT,
  );
  await kernel.quotes.confirmDraft(draft.id, HUMAN);
  return draft.id;
}

async function json(response: Response): Promise<{ [key: string]: unknown }> {
  return (await response.json()) as { [key: string]: unknown };
}

describe("报价链接 HTTP（e2e）", () => {
  it("生成 → 客户无登录查看 → 接受 → 业务员看到访问数据 → 撤回", async (ctx) => {
    if (!available || !db) ctx.skip();
    const database = db;
    if (!database) throw new Error("数据库不可用");
    const kernel = createKernel(database);
    const quoteId = await approvedQuote(kernel);

    const createdResponse = await fetch(`${baseUrl}/api/quotes/${quoteId}/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requirePhoneTail: true, allowPdf: true }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await json(createdResponse);
    const data = created.data as { url: string; token: string; share: { id: string } };
    expect(data.url).toContain(`/s/${data.token}`);

    const viewResponse = await fetch(`${baseUrl}/api/public/quotes/${data.token}`, {
      headers: { "x-forwarded-for": "198.51.100.8", "user-agent": "e3-http-test" },
    });
    expect(viewResponse.status).toBe(200);
    const view = await json(viewResponse);
    const page = view.data as {
      view: { customerName: string; totalAmount: number; lines: unknown[] };
    };
    expect(page.view.customerName).toBe("上海云锦贸易");
    expect(page.view.totalAmount).toBe(570000);
    expect(page.view.lines).toHaveLength(1);

    const wrongTail = await fetch(`${baseUrl}/api/public/quotes/${data.token}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneTail: "0000" }),
    });
    expect(wrongTail.status).toBe(400);
    const wrongBody = await json(wrongTail);
    expect((wrongBody.error as { code: string }).code).toBe("PHONE_TAIL_MISMATCH");

    const accepted = await fetch(`${baseUrl}/api/public/quotes/${data.token}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneTail: "1234" }),
    });
    expect(accepted.status).toBe(201);
    const acceptedBody = await json(accepted);
    expect((acceptedBody.data as { nextStep: string }).nextStep).toContain("成交意向");

    const question = await fetch(`${baseUrl}/api/public/quotes/${data.token}/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "能便宜一点吗？", lineIndex: 0 }),
    });
    expect(question.status).toBe(201);

    const statsResponse = await fetch(`${baseUrl}/api/quotes/${quoteId}/shares`);
    const stats = (await json(statsResponse)) as {
      data: {
        shares: Array<{ viewCount: number; acceptedAt: string | null; questions: unknown[] }>;
      };
    };
    const entry = stats.data.shares[0];
    expect(entry?.viewCount).toBe(1);
    expect(entry?.acceptedAt).toBeTruthy();
    expect(entry?.questions).toHaveLength(1);

    const revokeResponse = await fetch(`${baseUrl}/api/shares/${data.share.id}/revoke`, {
      method: "POST",
    });
    expect(revokeResponse.status).toBe(201);
    const afterRevoke = await fetch(`${baseUrl}/api/public/quotes/${data.token}`);
    expect(afterRevoke.status).toBe(410);
    expect(((await json(afterRevoke)).error as { code: string }).code).toBe("REVOKED");
  }, 40_000);

  it("非法 token 返回 404，草稿报价不能生成链接", async (ctx) => {
    if (!available || !db) ctx.skip();
    const database = db;
    if (!database) throw new Error("数据库不可用");
    const kernel = createKernel(database);

    const bad = await fetch(`${baseUrl}/api/public/quotes/not-a-token`);
    expect(bad.status).toBe(404);

    const id = suffix();
    const customer = await kernel.customers.create(
      { code: `E3H-D-${id}`, name: "草稿客户" },
      HUMAN,
    );
    const sample = await kernel.samples.create(
      { code: `E3H-DS-${id}`, name: "草稿布", unit: "meter" },
      HUMAN,
    );
    const draft = await kernel.quotes.generateDraft(
      {
        customerId: customer.id,
        currency: "CNY",
        items: [
          {
            fabricSampleId: sample.id,
            quantity: { value: 1, unit: "meter" },
            unitPrice: { amount: 3000, currency: "CNY" },
          },
        ],
      },
      AGENT,
    );
    const response = await fetch(`${baseUrl}/api/quotes/${draft.id}/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  }, 40_000);

  it("兼容移动端 T0 契约：POST /api/quote-shares 返回裸 CreatedQuoteShare，GET 返回访问时间线", async (ctx) => {
    if (!available || !db) ctx.skip();
    const database = db;
    if (!database) throw new Error("数据库不可用");
    const kernel = createKernel(database);
    const quoteId = await approvedQuote(kernel);

    const createResponse = await fetch(`${baseUrl}/api/quote-shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteId, requirePhoneTail: false, allowPdf: true }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await json(createResponse)) as {
      token?: string;
      url?: string;
      share?: { quoteId: string };
    };
    expect(created.token).toBeTruthy();
    expect(created.url).toContain("/s/");
    expect(created.share?.quoteId).toBe(quoteId);

    const token = created.token;
    if (!token) throw new Error("缺少 token");
    await fetch(`${baseUrl}/api/public/quotes/${token}`);
    const listResponse = await fetch(
      `${baseUrl}/api/quote-shares?quoteId=${encodeURIComponent(quoteId)}`,
    );
    expect(listResponse.status).toBe(200);
    const list = (await json(listResponse)) as {
      shares: Array<{
        share: { quoteId: string };
        url: string;
        viewCount: number;
        lastViewedAt: string | null;
      }>;
    };
    expect(list.shares).toHaveLength(1);
    expect(list.shares[0]?.share.quoteId).toBe(quoteId);
    expect(list.shares[0]?.url).toBe("");
    expect(list.shares[0]?.viewCount).toBe(1);
    expect(list.shares[0]?.lastViewedAt).toBeTruthy();
  }, 40_000);
});
