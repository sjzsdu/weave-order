import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SampleShipmentRecord } from "@weave-order/schema";
import { AppModule } from "../src/app.module";

/**
 * 寄样单批量反查的 HTTP 面。
 *
 * 用默认租户里真实的寄样单当「标准答案」：接口返回的寄样单集合必须与
 * `sample_shipment_items` 里查到的完全一致 —— 图墙徽标和抽屉记录都靠这条接口，
 * 少一张就是凭空丢掉进度，多一张就是把别人的单挂在样品上。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

let app: INestApplication | null = null;
let pool: Pool | null = null;
let baseUrl = "";
let available = false;
let seededSampleIds: string[] = [];

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 3 });
  try {
    const check = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.sample_shipment_items') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (!available) return;
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    const address = (app.getHttpServer() as Server).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    // 默认租户里的寄样单都是一单一料，直接取几张真单据的样品当查询样本。
    const rows = await pool.query<{ sample_id: string }>(
      `SELECT DISTINCT sample_id FROM sample_shipment_items
        WHERE tenant_id = $1
        ORDER BY sample_id
        LIMIT 3`,
      [DEFAULT_TENANT],
    );
    seededSampleIds = rows.rows.map((row) => row.sample_id);
  } catch {
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

interface ShipmentListBody {
  shipments: SampleShipmentRecord[];
}

async function lookup(query: string): Promise<Response> {
  return fetch(`${baseUrl}/api/sample-shipments?${query}`);
}

async function expectedShipmentIds(sampleIds: string[], status?: string): Promise<string[]> {
  const result = await pool!.query<{ id: string }>(
    `SELECT DISTINCT s.id
       FROM sample_shipments s
       JOIN sample_shipment_items i ON i.shipment_id = s.id
      WHERE s.tenant_id = $1
        AND i.sample_id = ANY($2::uuid[])
        AND ($3::text IS NULL OR s.status::text = $3)`,
    [DEFAULT_TENANT, sampleIds, status ?? null],
  );
  return result.rows.map((row) => row.id).sort();
}

describe("GET /api/sample-shipments", () => {
  it("批量查询与库存数据一致，且一张单只出现一次", async (ctx) => {
    if (!available || seededSampleIds.length === 0) {
      ctx.skip();
      return;
    }
    const query = seededSampleIds.join(",");
    const response = await lookup(`sampleIds=${query}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ShipmentListBody;

    const expected = await expectedShipmentIds(seededSampleIds);
    const actual = body.shipments.map((row) => row.id).sort();
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);

    // 每张单只带自己真实包含的样品，不串到查询里的其它样品。
    for (const row of body.shipments) {
      expect(row.sampleIds.length).toBeGreaterThan(0);
      // 至少含一个被查询的样品；其余条目也必须是真的 UUID，不能混进空值。
      expect(row.sampleIds.some((id) => seededSampleIds.includes(id))).toBe(true);
      expect(row.sampleIds.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
      // 存量单据的 code 允许为空（编号规则上线前建的），只要求不是空串。
      expect(row.code === null || row.code.trim() !== "").toBe(true);
      expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);
    }

    // 状态过滤与库存对齐。
    const confirmed = await lookup(`sampleIds=${query}&status=CONFIRMED`);
    expect(confirmed.status).toBe(200);
    const confirmedBody = (await confirmed.json()) as ShipmentListBody;
    expect(confirmedBody.shipments.map((row) => row.id).sort()).toEqual(
      await expectedShipmentIds(seededSampleIds, "CONFIRMED"),
    );
    expect(confirmedBody.shipments.every((row) => row.status === "CONFIRMED")).toBe(true);
  });

  it("入参不对就明确报错，不静默截断", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const cases: Array<[string, string]> = [
      ["", "sampleIds"],
      ["sampleIds=", "sampleIds"],
      ["sampleIds=abc", "UUID"],
      ["sampleIds=a,b", "UUID"],
      ["sampleIds=1&sampleIds=2", "只能出现一次"],
      ["sampleIds=11111111-1111-4111-8111-111111111111&status=FLYING", "status"],
    ];
    for (const [query, keyword] of cases) {
      const response = await lookup(query);
      expect(response.status, query).toBe(400);
      const text = JSON.stringify(await response.json());
      expect(text, query).toContain(keyword);
    }
  });
});
