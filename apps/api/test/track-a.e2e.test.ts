import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ApprovalDecisionInput,
  QuoteApprovalView,
  ReviseQuoteDraftResult,
  T004GenerateQuoteDraftResult,
} from "@weave-order/schema";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * Track A HTTP 面：改稿 / 审批卡详情 / 定价解析 / 带版本审批。
 * 真实启动 Nest + 真连 PG；没有数据库时整组跳过。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const HUMAN: KernelContext = {
  actor: { type: "HUMAN", id: "track-a-e2e-owner", role: "OWNER" },
};
let app: INestApplication | null = null;
let baseUrl = "";
let db: Db | null = null;
let available = false;

beforeAll(async () => {
  try {
    const handle = createDb(DATABASE_URL);
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.pricing_policies') IS NOT NULL AS exists",
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
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
});

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; json: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, json: await response.json() };
}

async function getJson(path: string): Promise<{ ok: boolean; json: unknown }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { ok: response.ok, json: await response.json() };
}

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

describe("Track A HTTP 面（真起服务 + 真连 PG）", () => {
  it("草稿 → HTTP 改价 → 审批卡 diff/出处 → 带版本批准", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const kernel = createKernel(database);
    const id = suffix();
    const customer = await kernel.customers.create(
      { code: `TAE-C-${id}`, name: "HTTP 客户" },
      HUMAN,
    );
    const sample = await kernel.samples.create(
      {
        code: `TAE-S-${id}`,
        name: "HTTP 面料",
        unit: "meter",
        costFloor: { amount: 1000, currency: "CNY" },
      },
      HUMAN,
    );

    const quoteRes = await postJson("/api/tools/generate-quote-draft", {
      customerId: customer.id,
      currency: "CNY",
      items: [
        {
          fabricSampleId: sample.id,
          quantity: { value: 100, unit: "meter" },
          unitPrice: { amount: 1500, currency: "CNY" },
        },
      ],
    });
    expect(quoteRes.ok).toBe(true);
    const quote = T004GenerateQuoteDraftResult.parse(quoteRes.json);
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;

    const reviseRes = await postJson("/api/quotes/revise", {
      quoteId: quote.data.draft.id,
      baseVersion: 1,
      source: "INLINE",
      instruction: "单价改 16.00",
      lines: [{ lineIndex: 0, unitPrice: { amount: 1600, currency: "CNY" } }],
    });
    expect(reviseRes.ok).toBe(true);
    const revised = ReviseQuoteDraftResult.parse(reviseRes.json);
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.data.draft.version).toBe(2);
    expect(revised.data.diff.length).toBeGreaterThan(0);

    const viewRes = await getJson(`/api/quotes/${quote.data.draft.id}/approval-view`);
    expect(viewRes.ok).toBe(true);
    const view = QuoteApprovalView.parse((viewRes.json as { view: unknown }).view);
    expect(view.version).toBe(2);
    expect(view.items[0]?.provenance).toBeTruthy();
    expect(view.requirement.level).toBeTruthy();

    const resolveRes = await getJson(
      `/api/pricing/resolve?key=pricing.min_margin_pct&customerId=${customer.id}`,
    );
    expect(resolveRes.ok).toBe(true);
    const resolved = (resolveRes.json as { resolved: { key: string; source: unknown } }).resolved;
    expect(resolved.key).toBe("pricing.min_margin_pct");
    expect(resolved.source).toBeTruthy();

    const decision = ApprovalDecisionInput.parse({
      id: quote.data.draft.id,
      kind: "quote",
      decision: "APPROVE",
      baseVersion: 2,
    });
    const decideRes = await postJson("/api/approvals/decide", decision);
    expect(decideRes.ok).toBe(true);
    const outcome = decideRes.json as { ok: boolean; data?: { status: string } };
    expect(outcome.ok).toBe(true);
    expect(outcome.data?.status).toBe("SENT");
  }, 30_000);
});
