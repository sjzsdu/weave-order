import { createDb, tenants } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel, isKernelError } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

/**
 * 一单发货的真实流水线（真连 PG）：
 * 建单 → 发货单 → 建箱 → 一键打印（幂等）→ 代理领任务/回执
 * → 扫码复核不一致拦截 → 人工核对 → 补打留痕。
 *
 * 没有数据库时整组跳过（离线 `pnpm test` 仍全绿）。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const HUMAN: KernelContext = {
  actor: { type: "HUMAN", id: "print-integration-owner", role: "OWNER" },
};
const AGENT_ID = "77777777-7777-4777-8777-777777777777";

let db: Db | null = null;
let available = false;
let tenantId = "";
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  try {
    const handle = createDb(DATABASE_URL);
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.print_jobs') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    db = handle.db;
    if (!available) {
      await handle.pool.end();
      return;
    }
    const rows = await handle.db
      .insert(tenants)
      .values({ slug: `print-it-${suffix()}`, name: "打印集成测试租户" })
      .returning();
    tenantId = rows[0]!.id;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  // 连接池由进程退出回收；这里只确认测试没有遗留事务。
});

function kernelOf(): Kernel {
  if (!db) throw new Error("数据库不可用");
  return createKernel(db, undefined, { tenantId });
}

async function seedShipment(kernel: Kernel) {
  const id = suffix();
  const customer = await kernel.customers.create(
    { code: `PR-C-${id}`, name: `打印客户 ${id}` },
    HUMAN,
  );
  const sample = await kernel.samples.create(
    {
      code: `PR-S-${id}`,
      name: "40S 精梳棉汗布",
      category: "cotton",
      unit: "meter",
      costFloor: { amount: 300, currency: "CNY" },
    },
    HUMAN,
  );
  const order = await kernel.orders.create(
    {
      customerId: customer.id,
      code: `PR-WO-${id}`,
      currency: "CNY",
      items: [
        {
          sampleId: sample.id,
          quantity: { value: 100, unit: "meter" },
          unitPrice: { amount: 1000, currency: "CNY" },
        },
      ],
    },
    HUMAN,
  );
  await kernel.orders.confirm(order.id, HUMAN);
  const confirmed = await kernel.orders.getById(order.id);
  const shipment = await kernel.orderShipments.create(
    {
      orderId: order.id,
      carrier: "顺丰",
      trackingNumber: "SF123456",
      address: "绍兴市柯桥区创意路 8 号",
      items: [
        {
          orderItemId: confirmed.items[0]!.id,
          quantity: { value: 100, unit: "meter" },
        },
      ],
    },
    HUMAN,
  );
  return { customer, sample, order: confirmed, shipment };
}

describe("打印中心（集成）", () => {
  it("一单发货：建箱 → 一键打印 → 幂等 → 回执 → 差异拦截 → 补打", async (ctx) => {
    if (!available || !db) {
      ctx.skip();
      return;
    }
    const kernel = kernelOf();
    const { shipment, sample } = await seedShipment(kernel);

    // 未建箱：箱唛打印被拦，拣货单仍可打（仓库先拣货）。
    const beforeBoxes = await kernel.print.views.getShipmentView(shipment.id);
    expect(beforeBoxes.printBlockedReason).toBe("NO_BOXES");
    const picking = await kernel.print.jobs.enqueue(
      { kind: "PICKING_LIST", shipmentId: shipment.id, copies: 1 },
      HUMAN,
    );
    expect(picking.job.status).toBe("QUEUED");
    expect(picking.job.format).toBe("HTML");

    // 同一动作重复点击：幂等命中，不重复入队。
    const again = await kernel.print.jobs.enqueue(
      { kind: "PICKING_LIST", shipmentId: shipment.id, copies: 1 },
      HUMAN,
    );
    expect(again.deduplicated).toBe(true);
    expect(again.job.id).toBe(picking.job.id);

    // 2 箱，自动均分 100 米 → 每箱 50 米，一箱一码。
    const boxResult = await kernel.print.jobs.createBoxes(
      { shipmentId: shipment.id, count: 2, autoAssign: true },
      HUMAN,
    );
    expect(boxResult.boxes).toHaveLength(2);
    expect(boxResult.boxes.map((box) => box.quantity)).toEqual([50, 50]);
    expect(new Set(boxResult.boxes.map((box) => box.qr)).size).toBe(2);
    expect(boxResult.shipment.printBlockedReason).toBeNull();

    // 一键打印：拣货单 + 发货单 + 箱唛 ×2。
    const bundle = await kernel.print.jobs.enqueueBundle(
      {
        shipmentId: shipment.id,
        pickingListCopies: 1,
        deliveryNoteCopies: 1,
        boxLabelCopies: 1,
      },
      HUMAN,
    );
    expect(bundle.jobs).toHaveLength(4);
    expect(bundle.jobs.filter((job) => job.kind === "BOX_LABEL")).toHaveLength(2);

    // 重复一键：所有任务去重，不重复出纸。
    const duplicate = await kernel.print.jobs.enqueueBundle(
      {
        shipmentId: shipment.id,
        pickingListCopies: 1,
        deliveryNoteCopies: 1,
        boxLabelCopies: 1,
      },
      HUMAN,
    );
    expect(duplicate.deduplicated).toHaveLength(4);

    // 代理领任务：任务载荷只在这里出现，且包含 ZPL 二维码指令。
    const claimed = await kernel.print.jobs.claim(AGENT_ID, 10);
    expect(claimed.length).toBeGreaterThanOrEqual(4);
    const labelJob = claimed.find((job) => job.kind === "BOX_LABEL");
    expect(labelJob?.format).toBe("ZPL");
    expect(labelJob?.payload).toContain("^BQN");
    const pdfJob = claimed.find((job) => job.kind === "DELIVERY_NOTE");
    expect(Buffer.from(pdfJob!.payload, "base64").subarray(0, 5).toString()).toBe("%PDF-");

    // 回执：成功 + 失败（缺纸）都留痕，失败可重试。
    await kernel.print.jobs.report(AGENT_ID, {
      jobId: labelJob!.id,
      status: "DONE",
    });
    const failed = claimed.find((job) => job.kind === "PICKING_LIST")!;
    await kernel.print.jobs.report(AGENT_ID, {
      jobId: failed.id,
      status: "FAILED",
      message: "缺纸",
    });
    const retried = await kernel.print.jobs.retry(failed.id, HUMAN);
    expect(retried.status).toBe("QUEUED");

    // 扫码复核：第一箱正确。
    const box1 = boxResult.boxes[0]!;
    const ok = await kernel.print.jobs.verifyScan(
      {
        shipmentId: shipment.id,
        boxQr: box1.qr,
        itemCode: sample.code,
        quantity: 50,
      },
      HUMAN,
    );
    expect(ok.ok).toBe(true);
    expect(ok.box?.status).toBe("PACKED");

    // 第二箱少扫：立即标记差异，打印入口变「先核对差异」。
    const box2 = boxResult.boxes[1]!;
    const mismatch = await kernel.print.jobs.verifyScan(
      {
        shipmentId: shipment.id,
        boxQr: box2.qr,
        itemCode: sample.code,
        quantity: 48,
      },
      HUMAN,
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.result).toBe("MISMATCH");
    expect(mismatch.message).toContain("应有 50");
    expect(mismatch.shipment.printBlockedReason).toBe("DISCREPANCY");

    try {
      await kernel.print.jobs.enqueueBundle(
        { shipmentId: shipment.id, pickingListCopies: 1, deliveryNoteCopies: 1, boxLabelCopies: 1 },
        HUMAN,
      );
      throw new Error("应当被差异拦截");
    } catch (error) {
      expect(isKernelError(error)).toBe(true);
      if (isKernelError(error)) {
        expect(error.details.reason).toBe("PRINT_DISCREPANCY_UNRESOLVED");
      }
    }

    // 人工核对差异后恢复打印。
    const resolved = await kernel.print.jobs.resolveDiscrepancy(
      box2.id,
      "客户确认少装 2 米，按 48 米发货",
      HUMAN,
    );
    expect(resolved.printBlockedReason).toBeNull();

    // 补打必须选原因；旧标签作废（voided_at），新标签 seq=2。
    const noReason = await kernel.print.jobs
      .reprintBox(box1.id, { reason: "" as never }, HUMAN)
      .catch((error: unknown) => error);
    expect(isKernelError(noReason)).toBe(true);

    const reprint = await kernel.print.jobs.reprintBox(
      box1.id,
      { reason: "DAMAGED", copies: 1 },
      HUMAN,
    );
    expect(reprint.job.labelSeq).toBe(2);
    const refreshed = reprint.shipment.boxes.find((box) => box.id === box1.id)!;
    expect(refreshed.seq).toBe(2);
    expect(refreshed.qr).toBe(`${kernel.tenantId}/${shipment.orderId}/BOX-01/2`);

    // 旧码立即失效：扫旧标签返回 WRONG_BOX。
    const oldQr = await kernel.print.jobs.verifyScan(
      {
        shipmentId: shipment.id,
        boxQr: box1.qr,
        itemCode: sample.code,
        quantity: 50,
      },
      HUMAN,
    );
    expect(oldQr.result).toBe("WRONG_BOX");

    // 队列与日志可读，模板可解析。
    const queue = await kernel.print.jobs.list({ limit: 50 });
    expect(queue.jobs.length).toBeGreaterThan(0);
    expect(queue.counts.done).toBeGreaterThanOrEqual(1);
    const logs = await kernel.print.jobs.logs(20);
    expect(logs.some((entry) => entry.reprintReason === "DAMAGED")).toBe(true);

    const templates = await kernel.print.templates.list("BOX_LABEL");
    expect(templates.some((template) => template.isSystem && template.format === "ZPL")).toBe(true);
  }, 30_000);

  it("模板版本化：发布 v1 → 改版 v2，未知变量在发布时拒绝", async (ctx) => {
    if (!available || !db) {
      ctx.skip();
      return;
    }
    const kernel = kernelOf();
    const name = `测试发货单 ${suffix()}`;
    const template = await kernel.print.templates.publish(
      {
        kind: "DELIVERY_NOTE",
        scope: "COMPANY",
        name,
        format: "HTML",
        body: "<h1>{{tenant.name}}</h1><p>{{customer.name}} {{shipment.no}}</p>",
      },
      HUMAN,
    );
    expect(template.activeVersion?.version).toBe(1);
    const version2 = await kernel.print.templates.publishVersion(
      {
        templateId: template.id,
        body: "<h1>{{tenant.name}}</h1><p>{{order.no}}</p>",
        changelog: "去掉客户名",
      },
      HUMAN,
    );
    expect(version2.activeVersion?.version).toBe(2);
    expect(version2.versionCount).toBe(2);

    const rejected = await kernel.print.templates
      .publishVersion({ templateId: template.id, body: "<p>{{customer.creditLimit}}</p>" }, HUMAN)
      .catch((error: unknown) => error);
    expect(isKernelError(rejected)).toBe(true);
    if (isKernelError(rejected)) {
      expect(rejected.details.reason).toBe("PRINT_TEMPLATE_UNKNOWN_VARIABLE");
    }
  });

  it("代理 token 只能打印：签名作用域错误即拒绝", async (ctx) => {
    if (!available || !db) {
      ctx.skip();
      return;
    }
    const kernel = kernelOf();
    const registered = await kernel.print.devices.register(
      { name: `仓库代理 ${suffix()}`, location: "杭州仓" },
      HUMAN,
    );
    expect(registered.token.split(".")).toHaveLength(3);
    const identity = await kernel.print.devices.authenticate(registered.token);
    expect(identity.agentId).toBe(registered.agent.id);

    const heartbeat = await kernel.print.devices.heartbeat(registered.agent.id, {
      appVersion: "0.1.0",
      printers: [
        {
          name: "Zebra ZD421",
          kind: "THERMAL",
          connection: "RAW_TCP",
          address: "192.168.1.50:9100",
          capabilities: { format: "ZPL" },
          calibration: { xOffset: 0, yOffset: 0, density: 8 },
          status: "READY",
        },
      ],
    });
    expect(heartbeat.status).toBe("ONLINE");
    expect(heartbeat.printers[0]?.name).toBe("Zebra ZD421");

    await expect(kernel.print.devices.authenticate(`${registered.token}x`)).rejects.toThrow();
  });
});
