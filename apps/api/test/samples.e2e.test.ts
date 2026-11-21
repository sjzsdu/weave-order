import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ForbiddenException } from "@nestjs/common";
import { createDb } from "@weave-order/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { rethrowHttp } from "../src/http/controllers";
import { KernelError } from "../src/kernel";

/**
 * 样品 HTTP 面：创建 / 409 唯一编码 / 详情 / 分页 / 归档。
 * 本地 dev 无令牌 => DEV_HUMAN_CONTEXT(OWNER)，所以这里只覆盖「人类可用路径」；
 * sales 的 403 由内核权限用例 + rethrowHttp 的 PERMISSION_DENIED→Forbidden 映射保证。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

let app: INestApplication | null = null;
let baseUrl = "";
let available = false;

beforeAll(async () => {
  try {
    const handle = createDb(DATABASE_URL);
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.sample_images') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    await handle.pool.end();
    if (!available) return;
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

const uniqueCode = () =>
  `HTTP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const uniqueToken = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface SampleListBody {
  samples: {
    id: string;
    composition: string | null;
    color?: string | null;
    weight: string | null;
    weightGsm?: number | null;
    code: string;
  }[];
  total: number;
  remaining: number;
  hasMore: boolean;
  nextCursor?: string | null;
  categories: string[];
  compositions: string[];
  weights: string[];
  colors: string[];
  weightGsmRange: { min: number; max: number } | null;
}

/** 每个用例创建的样品在结束后删掉：档位选项按真实数据聚合，残留会污染后续运行。 */
const createdSampleIds: string[] = [];

async function createSample(input: Record<string, unknown>): Promise<{ id: string }> {
  const response = await fetch(`${baseUrl}/api/samples`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: uniqueCode(), unit: "meter", ...input }),
  });
  expect([200, 201]).toContain(response.status);
  const body = (await response.json()) as { sample: { id: string } };
  createdSampleIds.push(body.sample.id);
  return body.sample;
}

async function deleteSamples(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const handle = createDb(DATABASE_URL);
  try {
    await handle.pool.query("delete from samples where id = any($1::uuid[])", [ids]);
  } finally {
    await handle.pool.end();
  }
}

afterEach(async () => {
  await deleteSamples(createdSampleIds.splice(0));
});

async function listSamples(search: Record<string, string> = {}): Promise<SampleListBody> {
  const qs = new URLSearchParams(search).toString();
  const response = await fetch(`${baseUrl}/api/samples${qs ? `?${qs}` : ""}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SampleListBody;
}

describe("样品 HTTP（e2e）", () => {
  it("创建 → 详情 → 编辑 → 归档；无图时 images=[] 且 primaryImageUrl=null", async (ctx) => {
    if (!available) ctx.skip();
    const code = uniqueCode();
    const created = await fetch(`${baseUrl}/api/samples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "HTTP 图墙样品", composition: "100% 棉", unit: "meter" }),
    });
    expect([200, 201]).toContain(created.status);
    const createdBody = (await created.json()) as {
      sample: { id: string; images: unknown[]; primaryImageUrl: string | null; code: string };
    };
    expect(createdBody.sample.code).toBe(code);
    expect(createdBody.sample.images).toEqual([]);
    expect(createdBody.sample.primaryImageUrl).toBeNull();

    const detail = await fetch(`${baseUrl}/api/samples/${createdBody.sample.id}`);
    expect(detail.status).toBe(200);

    const patched = await fetch(`${baseUrl}/api/samples/${createdBody.sample.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "HTTP 图墙样品（改名）",
        costFloor: { amount: 1234, currency: "CNY" },
      }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { sample: { name: string } };
    expect(patchedBody.sample.name).toBe("HTTP 图墙样品（改名）");

    const listed = await fetch(
      `${baseUrl}/api/samples?query=${encodeURIComponent(code)}&status=ALL`,
    );
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as {
      samples: { id: string }[];
      total: number;
      categories: string[];
      remaining: number;
      hasMore: boolean;
    };
    expect(listBody.samples.some((sample) => sample.id === createdBody.sample.id)).toBe(true);
    expect(typeof listBody.total).toBe("number");
    expect(Array.isArray(listBody.categories)).toBe(true);

    const archived = await fetch(`${baseUrl}/api/samples/${createdBody.sample.id}/archive`, {
      method: "POST",
    });
    expect(archived.status).toBe(200);
    const archivedBody = (await archived.json()) as { sample: { status: string } };
    expect(archivedBody.sample.status).toBe("ARCHIVED");
  });

  it("同一编码重复创建返回 409，文案「该编码已存在」", async (ctx) => {
    if (!available) ctx.skip();
    const code = uniqueCode();
    const body = JSON.stringify({ code, name: "重复编码", unit: "meter" });
    const first = await fetch(`${baseUrl}/api/samples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect([200, 201]).toContain(first.status);
    const second = await fetch(`${baseUrl}/api/samples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { message?: string | { message?: string } };
    const message =
      typeof secondBody.message === "string" ? secondBody.message : secondBody.message?.message;
    expect(message).toContain("该编码已存在");
  });

  it("非法 status 返回 400，而不是静默当成 ACTIVE", async (ctx) => {
    if (!available) ctx.skip();
    const response = await fetch(`${baseUrl}/api/samples?status=BOGUS`);
    expect(response.status).toBe(400);
  });

  it("金额不是整数分时返回 400（契约拒绝浮点金额）", async (ctx) => {
    if (!available) ctx.skip();
    const response = await fetch(`${baseUrl}/api/samples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: uniqueCode(),
        name: "浮点金额",
        unit: "meter",
        costFloor: { amount: 12.5, currency: "CNY" },
      }),
    });
    expect(response.status).toBe(400);
  });

  it("成分 + 克重档位 + 品类组合筛选同时生效", async (ctx) => {
    if (!available) ctx.skip();
    const token = uniqueToken();
    const composition = `棉-${token}`;
    const category = `针织-${token}`;
    const weightA = `220g/m²-${token}`;
    const weightB = `320g/m²-${token}`;
    const otherCategory = `梭织-${token}`;
    const otherComposition = `涤纶-${token}`;

    const hit = await createSample({
      composition,
      category,
      weight: weightA,
      name: "组合筛选命中",
    });
    const wrongWeight = await createSample({
      composition,
      category,
      weight: weightB,
      name: "克重不符",
    });
    const wrongCategory = await createSample({
      composition,
      category: otherCategory,
      weight: weightA,
      name: "品类不符",
    });
    const wrongComposition = await createSample({
      composition: otherComposition,
      category,
      weight: weightA,
      name: "成分不符",
    });

    const body = await listSamples({ composition, weights: weightA, category });
    const ids = body.samples.map((sample) => sample.id);
    expect(ids).toContain(hit.id);
    expect(ids).not.toContain(wrongWeight.id);
    expect(ids).not.toContain(wrongCategory.id);
    expect(ids).not.toContain(wrongComposition.id);
    expect(body.samples.every((sample) => sample.composition === composition)).toBe(true);
    expect(body.samples.every((sample) => sample.weight === weightA)).toBe(true);
  });

  it("颜色 + 克重区间：颜色来自治理选项与原文，weight_gsm 只解析带单位的单一数值", async (ctx) => {
    if (!available) ctx.skip();
    const token = uniqueToken();
    const color = `藏青-${token}`;
    const hit = await createSample({ color, weight: "220g/m2", name: `范围命中-${token}` });
    const yarn = await createSample({ color, weight: "32S/2", name: `纱支-${token}` });

    const byColor = await listSamples({ colors: color });
    expect(byColor.samples.map((sample) => sample.id).sort()).toEqual([hit.id, yarn.id].sort());
    expect(byColor.colors).toContain(color);
    // 纱支不写克重：区间里只剩 220。
    expect(byColor.weightGsmRange).toEqual({ min: 220, max: 220 });

    const byRange = await listSamples({
      colors: color,
      weightGsmMin: "200",
      weightGsmMax: "240",
    });
    expect(byRange.samples.map((sample) => sample.id)).toEqual([hit.id]);
    expect(byRange.samples[0]?.weightGsm).toBe(220);
  });

  it("组合筛选命中 0 条返回空数组与 hasMore=false，而不是 400", async (ctx) => {
    if (!available) ctx.skip();
    const composition = `无结果-${uniqueToken()}`;
    const response = await fetch(
      `${baseUrl}/api/samples?composition=${encodeURIComponent(composition)}&weights=${encodeURIComponent("999g/m²")}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as SampleListBody;
    expect(body.samples).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.total).toBe(0);
    expect(body.nextCursor ?? null).toBeNull();
  });

  it("非法筛选参数返回 400：项数超限 / 单项超长 / 成分超长", async (ctx) => {
    if (!available) ctx.skip();
    const tooMany = Array.from({ length: 11 }, (_, index) => `w${index}`).join(",");
    const tooLongTier = "x".repeat(65);
    const tooLongComposition = "y".repeat(65);

    const cases = [
      `weights=${encodeURIComponent(tooMany)}`,
      `weights=${encodeURIComponent(tooLongTier)}`,
      `composition=${encodeURIComponent(tooLongComposition)}`,
    ];
    for (const query of cases) {
      const response = await fetch(`${baseUrl}/api/samples?${query}`);
      expect(response.status, query).toBe(400);
      const body = (await response.json()) as { message?: string | { message?: string } };
      const message = typeof body.message === "string" ? body.message : body.message?.message;
      expect(message).toBeTruthy();
      expect(message).toMatch(/[成分克重]/);
    }
  });

  it("档位选项稳定：不跟随已选筛选，只统计当前状态的非空值", async (ctx) => {
    if (!available) ctx.skip();
    const token = uniqueToken();
    const activeComposition = `稳定-${token}`;
    const archivedComposition = `归档-${token}`;
    const archivedWeight = `500g/m²-${token}`;
    await createSample({
      name: "稳定档位在售",
      composition: activeComposition,
      weight: `180g/m²-${token}`,
    });
    await createSample({
      name: "稳定档位归档",
      composition: archivedComposition,
      weight: archivedWeight,
      status: "ARCHIVED",
    });

    const baseline = await listSamples();
    const filtered = await listSamples({ composition: activeComposition });
    expect(filtered.compositions).toEqual(baseline.compositions);
    expect(filtered.weights).toEqual(baseline.weights);

    // 归档样品不进入 ACTIVE 的档位列表。
    expect(baseline.compositions).not.toContain(archivedComposition);
    expect(baseline.weights).not.toContain(archivedWeight);

    // 档位列表有 24 条截断，不能靠 `status=ALL` 里「出现归档值」来断言；
    // 改用精确 weights 过滤：ACTIVE 下 0 条，ARCHIVED 下命中，证明状态范围生效。
    expect((await listSamples({ weights: archivedWeight })).total).toBe(0);
    expect(
      (await listSamples({ weights: archivedWeight, status: "ARCHIVED" })).total,
    ).toBeGreaterThan(0);

    // 档位来自真实数据：任选一个都能选出结果；且数组里没有空字符串。
    expect(baseline.compositions.every((value) => value.length > 0)).toBe(true);
    expect(baseline.weights.every((value) => value.length > 0)).toBe(true);
    for (const weight of baseline.weights) {
      const page = await listSamples({ weights: weight });
      expect(page.total, weight).toBeGreaterThan(0);
    }
  });

  it("内核 PERMISSION_DENIED 映射为 HTTP 403（sales 写样品）", () => {
    expect(() =>
      rethrowHttp(new KernelError("PERMISSION_DENIED", "当前角色没有样品写权限")),
    ).toThrow(ForbiddenException);
  });
});
