import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, memberships, tenants } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * 打印中心 HTTP + 代理 WSS：真起 Nest、真连 PG。
 * 重点验证「代理 token 只能打印、不能读业务数据」。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const HUMAN: KernelContext = {
  actor: { type: "HUMAN", id: "print-e2e-owner", role: "OWNER" },
};
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let app: INestApplication | null = null;
let baseUrl = "";
let db: Db | null = null;
let available = false;
let tenantId = "";
let humanAuth: Record<string, string> = {};

beforeAll(async () => {
  try {
    const handle = createDb(DATABASE_URL);
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.print_jobs') IS NOT NULL AS exists",
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
    const tenantRows = await handle.db
      .insert(tenants)
      .values({ slug: `print-e2e-${suffix()}`, name: "打印 E2E 租户" })
      .returning();
    tenantId = tenantRows[0]!.id;
    const subject = `print-e2e-${suffix()}`;
    await handle.db.insert(memberships).values({
      tenantId,
      subject,
      role: "OWNER",
      status: "ACTIVE",
    });
    humanAuth = { Authorization: `Bearer dev:${subject}` };
  } catch {
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
});

async function json(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...humanAuth, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function seed(kernel: ReturnType<typeof createKernel>) {
  const id = suffix();
  const customer = await kernel.customers.create(
    { code: `PE-C-${id}`, name: "HTTP 打印客户" },
    HUMAN,
  );
  const sample = await kernel.samples.create(
    {
      code: `PE-S-${id}`,
      name: "HTTP 打印面料",
      unit: "piece",
      costFloor: { amount: 100, currency: "CNY" },
    },
    HUMAN,
  );
  const order = await kernel.orders.create(
    {
      customerId: customer.id,
      code: `PE-WO-${id}`,
      currency: "CNY",
      items: [
        {
          sampleId: sample.id,
          quantity: { value: 20, unit: "piece" },
          unitPrice: { amount: 500, currency: "CNY" },
        },
      ],
    },
    HUMAN,
  );
  await kernel.orders.confirm(order.id, HUMAN);
  return { customer, sample, order: await kernel.orders.getById(order.id) };
}

describe("打印中心 HTTP / WSS（e2e）", () => {
  it("人工建发货单/箱 → 一键打印 → 代理 token 只打印不读业务数据", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const kernel = createKernel(database, undefined, { tenantId });
    const { order, sample } = await seed(kernel);

    const created = await json(`/api/orders/${order.id}/shipments`, {
      method: "POST",
      body: JSON.stringify({
        carrier: "顺丰",
        trackingNumber: "SF-E2E",
        address: "杭州市余杭区仓前街道 1 号",
        items: [
          {
            orderItemId: order.items[0]!.id,
            quantity: { value: 20, unit: "piece" },
          },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const shipmentId = (created.body as { shipment: { id: string } }).shipment.id;

    const boxes = await json(`/api/shipments/${shipmentId}/boxes`, {
      method: "POST",
      body: JSON.stringify({ count: 4, autoAssign: true }),
    });
    expect(boxes.status).toBe(201);
    const boxList = (boxes.body as { boxes: Array<{ id: string; qr: string; quantity: number }> })
      .boxes;
    expect(boxList).toHaveLength(4);
    expect(boxList.every((box) => box.quantity === 5)).toBe(true);

    const bundle = await json("/api/print/jobs/bundle", {
      method: "POST",
      body: JSON.stringify({
        shipmentId,
        pickingListCopies: 1,
        deliveryNoteCopies: 1,
        boxLabelCopies: 1,
      }),
    });
    expect(bundle.status).toBe(201);
    expect((bundle.body as { jobs: unknown[] }).jobs).toHaveLength(6);
    const duplicate = await json("/api/print/jobs/bundle", {
      method: "POST",
      body: JSON.stringify({
        shipmentId,
        pickingListCopies: 1,
        deliveryNoteCopies: 1,
        boxLabelCopies: 1,
      }),
    });
    expect((duplicate.body as { deduplicated: string[] }).deduplicated).toHaveLength(6);

    // 注册代理：明文 token 只出现一次。
    const registered = await json("/api/print/devices/agents", {
      method: "POST",
      body: JSON.stringify({ name: `仓库打印代理 ${suffix()}`, location: "杭州仓" }),
    });
    expect(registered.status).toBe(201);
    const { token } = registered.body as { token: string };
    const agentAuth = { Authorization: `Bearer ${token}` };

    const heartbeat = await json("/api/print/agent/heartbeat", {
      method: "POST",
      headers: agentAuth,
      body: JSON.stringify({
        appVersion: "0.1.0",
        printers: [
          {
            name: "Zebra ZD421",
            kind: "THERMAL",
            connection: "RAW_TCP",
            address: "192.168.1.50:9100",
            capabilities: { format: "ZPL" },
            calibration: {},
            status: "READY",
          },
          {
            name: "HP LaserJet",
            kind: "A4",
            connection: "SYSTEM_DRIVER",
            address: "HP-LaserJet",
            capabilities: {},
            calibration: {},
            status: "READY",
          },
        ],
      }),
    });
    expect(heartbeat.status).toBe(201);
    expect((heartbeat.body as { status: string }).status).toBe("ONLINE");

    // 只读业务接口：代理 token 必须被拒（包括公开目录接口）。
    const customers = await json("/api/customers", { headers: agentAuth });
    expect(customers.status).toBe(403);
    const orderList = await json("/api/orders", { headers: agentAuth });
    expect(orderList.status).toBe(403);

    // 代理只能领任务、回报状态。
    const claimed = await json("/api/print/agent/claim", {
      method: "POST",
      headers: agentAuth,
      body: JSON.stringify({ limit: 10 }),
    });
    expect(claimed.status).toBe(201);
    const jobs = (claimed.body as { jobs: Array<{ id: string; kind: string; payload: string }> })
      .jobs;
    expect(jobs.length).toBe(6);
    expect(jobs.some((job) => job.kind === "BOX_LABEL" && job.payload.includes("^BQN"))).toBe(true);

    const done = await json("/api/print/agent/result", {
      method: "POST",
      headers: agentAuth,
      body: JSON.stringify({ jobId: jobs[0]!.id, status: "DONE" }),
    });
    expect(done.status).toBe(201);
    expect((done.body as { job: { status: string } }).job.status).toBe("DONE");

    // 扫码复核不一致：打印入口被锁。
    const mismatch = await json(`/api/shipments/${shipmentId}/verify-scan`, {
      method: "POST",
      body: JSON.stringify({
        boxQr: boxList[0]!.qr,
        itemCode: sample.code,
        quantity: 4,
      }),
    });
    expect(mismatch.status).toBe(201);
    expect((mismatch.body as { ok: boolean }).ok).toBe(false);
    const blocked = await json("/api/print/jobs/bundle", {
      method: "POST",
      body: JSON.stringify({
        shipmentId,
        pickingListCopies: 1,
        deliveryNoteCopies: 0,
        boxLabelCopies: 1,
      }),
    });
    expect(blocked.status).toBe(400);
    expect(JSON.stringify(blocked.body)).toContain("PRINT_DISCREPANCY_UNRESOLVED");

    // 打印中心聚合：队列 / 模板 / 设备 / 记录都在。
    const center = await json("/api/print/center");
    expect(center.status).toBe(200);
    const snapshot = center.body as {
      queue: { counts: { queued: number } };
      templates: unknown[];
      devices: { agents: unknown[] };
      logs: unknown[];
    };
    expect(snapshot.templates.length).toBeGreaterThan(0);
    expect(snapshot.devices.agents.length).toBeGreaterThan(0);
    expect(snapshot.logs.length).toBeGreaterThan(0);
  }, 30_000);

  it("代理 WSS 连接：token 鉴权后收到 hello，并可通过连接领任务", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const kernel = createKernel(database, undefined, { tenantId });
    const registered = await kernel.print.devices.register({ name: `WSS 代理 ${suffix()}` }, HUMAN);
    const wsUrl = `${baseUrl.replace("http://", "ws://")}/api/print/agent/ws?token=${encodeURIComponent(registered.token)}`;
    const socket = new WebSocket(wsUrl);
    const messages: Array<Record<string, unknown>> = [];
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WSS 超时")), 5000);
      socket.on("message", (data) => {
        const parsed = JSON.parse((data as Buffer).toString("utf8")) as Record<string, unknown>;
        messages.push(parsed);
        if (parsed.type === "hello") {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
      socket.on("error", reject);
    });
    expect(hello.agentId).toBe(registered.agent.id);
    socket.send(JSON.stringify({ type: "claim", limit: 2 }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("claim 超时")), 5000);
      socket.on("message", (data) => {
        const parsed = JSON.parse((data as Buffer).toString("utf8")) as Record<string, unknown>;
        messages.push(parsed);
        if (parsed.type === "jobs") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    expect(messages.some((message) => message.type === "jobs")).toBe(true);
    socket.close();
  }, 20_000);
});
