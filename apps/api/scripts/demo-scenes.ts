/**
 * 演示剧本数据（`data/demo-scenes.json` 的锚点）。
 *
 * 每份剧本都需要一笔「固定业务锚点」——重置后 uuid 会变，但客户编号不变，
 * 服务端据此把深链解析成当前库里的真实单据 id。
 *
 * 时间一律用相对时间（now - N days）写库，不存绝对时间戳：
 * 重置后「3 天前的待审批」永远成立，演示不依赖某一天。
 *
 * 幂等：同一客户名下已有同类型待办时不再新建；脚本可重复跑。
 *
 * 运行：pnpm --filter @weave-order/api demo:scenes
 */
import { sql } from "drizzle-orm";
import path from "node:path";
import { loadEnv } from "../src/platform/env";
import { connectDatabase } from "../src/platform/database";
import { createKernel } from "../src/kernel";
import { createApprovalService } from "../src/approval";
import type { KernelContext } from "../src/kernel";
import { demoWriteContext, ensureDemoIdentity } from "./demo-identity";

try {
  process.loadEnvFile(path.resolve(__dirname, "../../../.env"));
} catch {
  // 没有 .env 就用默认值。
}

const CUSTOMER_CODE = "DEMO-SCENE-001";
const CUSTOMER_NAME = "演示纺织 · 剧本";
const SAMPLE_CODE = "DEMO-SCENE-FABRIC-01";
const SAMPLE_NAME = "剧本面料 · 220g 精梳棉";

/** 剧本写库用的相对时间：集中在一处，免得各脚本各写一个「几天前」。 */
const RELATIVE = {
  customerDaysAgo: 7,
  quoteDaysAgo: 3,
  shipmentDaysAgo: 2,
} as const;

interface SceneAnchors {
  tenantId: string;
  customerId: string;
  customerCode: string;
  sampleId: string;
  quoteId: string | null;
  shipmentId: string | null;
  created: { quote: boolean; shipment: boolean };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, pool } = connectDatabase(env.DATABASE_URL);
  try {
    const tableCheck = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.customers') IS NOT NULL AS exists",
    );
    if (!tableCheck.rows[0]?.exists) {
      throw new Error("数据库表不存在，请先运行：pnpm db:migrate");
    }

    const identity = await ensureDemoIdentity(db);
    const kernel = createKernel(db, undefined, { tenantId: identity.tenantId });
    const human = demoWriteContext(identity, "demo-scene-seeder");
    // 脚本读路径按 OWNER 全量视角，避免某次失败后被数据范围挡住看不见旧数据。
    const readCtx: KernelContext = {
      ...human,
      actor: { ...human.actor, role: "OWNER" },
      dataScope: "ALL",
      teamId: null,
    };

    const customers = await kernel.customers.list({ query: CUSTOMER_CODE, limit: 20 }, readCtx);
    let customer = customers.find((row) => row.code === CUSTOMER_CODE);
    if (!customer) {
      const created = await kernel.customers.create(
        {
          code: CUSTOMER_CODE,
          name: CUSTOMER_NAME,
          tier: "VIP",
          contactName: "剧本人",
          contactPhone: "13800000000",
        },
        human,
      );
      customer = {
        ...created,
        ownerId: identity.salesMembershipId,
        ownerName: null,
        pendingQuoteCount: 0,
        inTransitSampleCount: 0,
        activeOrderCount: 0,
        receivableBalance: [],
        overdueReceivableCount: 0,
        lastContactAt: null,
      };
      console.log(`✔ 客户已创建：${CUSTOMER_CODE}`);
    } else {
      console.log(`· 客户已存在：${CUSTOMER_CODE}`);
    }

    const samplePage = await kernel.samples.listPage(
      { query: SAMPLE_CODE, status: "ALL", limit: 20 },
      readCtx,
    );
    let sample = samplePage.samples.find((row) => row.code === SAMPLE_CODE);
    if (!sample) {
      sample = await kernel.samples.create(
        {
          code: SAMPLE_CODE,
          name: SAMPLE_NAME,
          composition: "100% 棉",
          weight: "220g/m2",
          unit: "meter",
          costFloor: { amount: 1200, currency: "CNY" },
        },
        human,
      );
      console.log(`✔ 样品已创建：${SAMPLE_CODE}`);
    } else {
      console.log(`· 样品已存在：${SAMPLE_CODE}`);
    }

    const approvalService = createApprovalService(kernel);
    const pending = await approvalService.listPending(readCtx, { limit: 100 });

    let createdQuote = false;
    let quoteId = pending.items.find(
      (item) => item.kind === "quote" && item.customerId === customer.id,
    )?.id;
    if (!quoteId) {
      const draft = await kernel.quotes.generateDraft(
        {
          customerId: customer.id,
          currency: "CNY",
          validityDays: 30,
          remarks: "演示剧本：这张草稿等人类拍板",
          items: [
            {
              fabricSampleId: sample.id,
              quantity: { value: 500, unit: "meter" },
              unitPrice: { amount: 1850, currency: "CNY" },
            },
          ],
        },
        human,
      );
      quoteId = draft.id;
      createdQuote = true;
      console.log(`✔ 报价草稿已创建：${quoteId}`);
    } else {
      console.log(`· 报价草稿已存在：${quoteId}`);
    }

    let createdShipment = false;
    let shipmentId = pending.items.find(
      (item) => item.kind === "sample_shipment" && item.customerId === customer.id,
    )?.id;
    if (!shipmentId) {
      const shipment = await kernel.shipments.createDraft(
        {
          customerId: customer.id,
          items: [{ sampleId: sample.id, quantity: { value: 3, unit: "meter" } }],
          carrier: "顺丰",
          trackingNumber: "SF-DEMO-SCENE-001",
          note: "演示剧本：智能体只能建草稿，确认必须由人类完成",
        },
        human,
      );
      shipmentId = shipment.id;
      createdShipment = true;
      console.log(`✔ 寄样单草稿已创建：${shipmentId}`);
    } else {
      console.log(`· 寄样单草稿已存在：${shipmentId}`);
    }

    // 相对时间：用 SQL `now() - interval` 计算，代码里不出现任何绝对日期。
    if (createdQuote && quoteId) {
      await db.execute(sql`
        UPDATE quotes
           SET created_at = now() - (${RELATIVE.quoteDaysAgo} || ' days')::interval,
               updated_at = now() - (${RELATIVE.quoteDaysAgo} || ' days')::interval
         WHERE id = ${quoteId} AND tenant_id = ${identity.tenantId}
      `);
    }
    if (createdShipment && shipmentId) {
      await db.execute(sql`
        UPDATE sample_shipments
           SET created_at = now() - (${RELATIVE.shipmentDaysAgo} || ' days')::interval,
               updated_at = now() - (${RELATIVE.shipmentDaysAgo} || ' days')::interval
         WHERE id = ${shipmentId} AND tenant_id = ${identity.tenantId}
      `);
    }
    // 客户与样品同样落到「几天前」，让「最近联系 / 新样品」等相对时间文案在重置后一致。
    await db.execute(sql`
      UPDATE customers
         SET created_at = now() - (${RELATIVE.customerDaysAgo} || ' days')::interval
       WHERE tenant_id = ${identity.tenantId} AND code = ${CUSTOMER_CODE}
    `);
    await db.execute(sql`
      UPDATE samples
         SET created_at = now() - (${RELATIVE.customerDaysAgo} || ' days')::interval
       WHERE tenant_id = ${identity.tenantId} AND code = ${SAMPLE_CODE}
    `);

    const anchors: SceneAnchors = {
      tenantId: identity.tenantId,
      customerId: customer.id,
      customerCode: CUSTOMER_CODE,
      sampleId: sample.id,
      quoteId: quoteId ?? null,
      shipmentId: shipmentId ?? null,
      created: { quote: createdQuote, shipment: createdShipment },
    };
    // e2e / demo:reset 用最后一行 JSON 读取锚点，避免再解析人类可读日志。
    console.log(JSON.stringify(anchors));
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error("✖ 剧本数据生成失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
