import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ApprovalDecisionResult,
  ApprovalQueue,
  PanoramaSnapshot,
  T004GenerateQuoteDraftResult,
  T005CreateSampleShipmentResult,
} from "@weave-order/schema";
import { createDb } from "@weave-order/db";
import { quotes, sampleShipments } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * 审批窗口端到端：真实启动 Nest、真实连 PostgreSQL。
 * 覆盖「派发草稿 → 审批队列 → 批准/拒绝走 approval API → 内核 confirm/reject 落账
 * → 全景/审计可见 → 不可重复决策」整条链路。没有本地 PG 时整组跳过。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "e2e-approval-seed" } };

let app: INestApplication | null = null;
let baseUrl = "";
let db: Db | null = null;
let available = false;

beforeAll(async () => {
  try {
    const handle = createDb(DATABASE_URL);
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.quotes') IS NOT NULL AS exists",
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

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; json: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json();
  return { ok: response.ok, json };
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`);
  expect(response.ok).toBe(true);
  const json: unknown = await response.json();
  return json;
}

describe("审批窗口端到端（HTTP 真起服务 + 真连 PG）", () => {
  it("派发草稿 → 队列 → 批准/拒绝 → 内核落账 → 全景/审计可见，且不可重复决策", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const kernel = createKernel(database);
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const customer = await kernel.customers.create(
      { code: `AP-C-${suffix}`, name: "审批演示客户" },
      HUMAN,
    );
    const sample = await kernel.samples.create(
      {
        code: `AP-S-${suffix}`,
        name: "审批演示面料",
        unit: "meter",
        costFloor: { amount: 1200, currency: "CNY" },
      },
      HUMAN,
    );

    // ① 智能体身份派发两类草稿（只能得到 DRAFT）
    const quoteRes = await postJson("/api/tools/generate-quote-draft", {
      customerId: customer.id,
      currency: "CNY",
      items: [
        {
          fabricSampleId: sample.id,
          quantity: { value: 2, unit: "meter" },
          unitPrice: { amount: 1500, currency: "CNY" },
        },
      ],
    });
    expect(quoteRes.ok).toBe(true);
    const quoteParsed = T004GenerateQuoteDraftResult.parse(quoteRes.json);
    expect(quoteParsed.ok).toBe(true);
    if (!quoteParsed.ok) return;
    const quoteId = quoteParsed.data.draft.id;
    expect(quoteParsed.data.draft.status).toBe("DRAFT");

    const shipRes = await postJson("/api/tools/create-sample-shipment", {
      customerId: customer.id,
      items: [{ sampleId: sample.id, quantity: { value: 2, unit: "meter" } }],
      channel: "COURIER",
      carrier: "顺丰",
      trackingNumber: `SF${suffix}`,
    });
    expect(shipRes.ok).toBe(true);
    const shipParsed = T005CreateSampleShipmentResult.parse(shipRes.json);
    expect(shipParsed.ok).toBe(true);
    if (!shipParsed.ok) return;
    const shipmentId = shipParsed.data.shipment.id;
    expect(shipParsed.data.shipment.status).toBe("DRAFT");

    // ② 审批队列里两条都是 pending DRAFT
    const queueBefore = ApprovalQueue.parse(await getJson("/api/approvals"));
    for (const id of [quoteId, shipmentId]) {
      const found = queueBefore.items.find((entry) => entry.id === id);
      expect(found?.status).toBe("DRAFT");
      expect(found?.pending).toBe(true);
    }

    // ③ 批准报价：approval API → confirm → SENT（actor 固定 HUMAN）
    const approve = ApprovalDecisionResult.parse(
      (await postJson("/api/approvals/decide", { id: quoteId, kind: "quote", decision: "APPROVE" }))
        .json,
    );
    expect(approve.ok).toBe(true);
    if (approve.ok) {
      expect(approve.data.status).toBe("SENT");
      expect(approve.data.actorType).toBe("HUMAN");
    }

    // ④ 驳回寄样单：approval API → reject → CANCELLED（带分诊备注）
    const reject = ApprovalDecisionResult.parse(
      (
        await postJson("/api/approvals/decide", {
          id: shipmentId,
          kind: "sample_shipment",
          decision: "REJECT",
          note: "客户信息不全",
        })
      ).json,
    );
    expect(reject.ok).toBe(true);
    if (reject.ok) expect(reject.data.status).toBe("CANCELLED");

    // ⑤ 直接查账本：状态真的落库（不是只改了前端）
    const quoteRow = (await database.select().from(quotes).where(eq(quotes.id, quoteId)))[0];
    const shipRow = (
      await database.select().from(sampleShipments).where(eq(sampleShipments.id, shipmentId))
    )[0];
    expect(quoteRow?.status).toBe("SENT");
    expect(shipRow?.status).toBe("CANCELLED");

    // ⑥ 全景只读：合法 PanoramaSnapshot，且反映新状态与驳回计数
    const panorama = PanoramaSnapshot.parse(await getJson("/api/panorama"));
    expect(panorama.items.find((entry) => entry.id === quoteId)?.status).toBe("SENT");
    expect(panorama.items.find((entry) => entry.id === shipmentId)?.status).toBe("CANCELLED");
    expect(panorama.stats.rejectedCount).toBeGreaterThanOrEqual(1);

    // ⑦ 队列不再含这两条（已非 DRAFT）
    const queueAfter = ApprovalQueue.parse(await getJson("/api/approvals"));
    expect(queueAfter.items.some((entry) => entry.id === quoteId || entry.id === shipmentId)).toBe(
      false,
    );

    // ⑧ 重复批准 -> 业务错误，不伪造成功
    const again = ApprovalDecisionResult.parse(
      (await postJson("/api/approvals/decide", { id: quoteId, kind: "quote", decision: "APPROVE" }))
        .json,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("KERNEL_REJECTED");

    // ⑨ 审计：确认 / 驳回都由 HUMAN 落账（铁律 #2）
    const audit = (await getJson("/api/audit?limit=200")) as {
      entries: { action: string; entityId: string; actorType: string }[];
    };
    expect(
      audit.entries.some(
        (entry) =>
          entry.action === "QUOTE_CONFIRMED" &&
          entry.entityId === quoteId &&
          entry.actorType === "HUMAN",
      ),
    ).toBe(true);
    expect(
      audit.entries.some(
        (entry) =>
          entry.action === "SAMPLE_SHIPMENT_REJECTED" &&
          entry.entityId === shipmentId &&
          entry.actorType === "HUMAN",
      ),
    ).toBe(true);
  }, 30_000);

  it("非法决策入参返回 ok:false 的 INVALID_INPUT（不是 500）", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const res = await postJson("/api/approvals/decide", {
      id: "bad",
      kind: "quote",
      decision: "MAYBE",
    });
    expect(res.ok).toBe(true);
    const parsed = ApprovalDecisionResult.parse(res.json);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("INVALID_INPUT");
  });
});
