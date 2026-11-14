import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ForbiddenException } from "@nestjs/common";
import { createDb } from "@weave-order/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("内核 PERMISSION_DENIED 映射为 HTTP 403（sales 写样品）", () => {
    expect(() =>
      rethrowHttp(new KernelError("PERMISSION_DENIED", "当前角色没有样品写权限")),
    ).toThrow(ForbiddenException);
  });
});
