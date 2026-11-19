import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, createDb, DEFAULT_TENANT_ID } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { AppModule } from "../src/app.module";

/**
 * 操作日志 HTTP 面（WAN-179）：验证路由、查询参数解析与详情裁剪的接线。
 * 具体口径（权限范围、游标、导出内容）由 audit-log.integration.test.ts 覆盖。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

let app: INestApplication | null = null;
let baseUrl = "";
let db: Db | null = null;
let available = false;
const marker = `WAN-179-${randomUUID().slice(0, 8)}`;
let seq = 0;

beforeAll(async () => {
  try {
    const handle = createDb(DATABASE_URL);
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.audit_export_jobs') IS NOT NULL AS exists",
    );
    db = handle.db;
    available = check.rows[0]?.exists === true;
    if (!available) {
      await handle.pool.end();
      return;
    }
    const rows = await db
      .insert(auditLog)
      .values({
        tenantId: DEFAULT_TENANT_ID,
        actorType: "HUMAN",
        actorId: "web-approver",
        actorRole: "OWNER",
        actorName: "测试老板",
        action: "CUSTOMER_RENAMED",
        entityType: "customer",
        entityId: randomUUID(),
        entityLabel: marker,
        before: { name: "旧名" },
        after: { name: "新名" },
      })
      .returning({ seq: auditLog.seq });
    seq = rows[0]!.seq;

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

describe("操作日志 HTTP 面", () => {
  it("列表：关键词命中，返回 scope 与摘要", async (ctx) => {
    if (!available) ctx.skip();
    const response = await fetch(`${baseUrl}/api/audit/log?keyword=${encodeURIComponent(marker)}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      scope: string;
      items: Array<{ seq: number; action: string; highRisk: boolean; summary: string }>;
      nextCursor: number | null;
    };
    expect(body.scope).toBe("ALL");
    expect(body.items[0]).toMatchObject({ seq, action: "CUSTOMER_RENAMED", highRisk: false });
    expect(body.items[0]?.summary).toContain("修改了客户名称");
  });

  it("非法动作与游标直接 400，不落到数据库", async (ctx) => {
    if (!available) ctx.skip();
    const badAction = await fetch(`${baseUrl}/api/audit/log?action=NOT_A_REAL_ACTION`);
    expect(badAction.status).toBe(400);
    const badCursor = await fetch(`${baseUrl}/api/audit/log?cursor=abc`);
    expect(badCursor.status).toBe(400);
  });

  it("详情：返回字段级 before/after", async (ctx) => {
    if (!available) ctx.skip();
    const response = await fetch(`${baseUrl}/api/audit/log/${seq}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entry: { before: { name: string }; after: { name: string }; maskedFields: string[] };
    };
    expect(body.entry.before).toMatchObject({ name: "旧名" });
    expect(body.entry.after).toMatchObject({ name: "新名" });
    expect(body.entry.maskedFields).toEqual([]);
  });

  it("不存在的序号返回 404，而不是 500", async (ctx) => {
    if (!available) ctx.skip();
    const response = await fetch(`${baseUrl}/api/audit/log/999999999`);
    expect(response.status).toBe(404);
  });

  it("摘要接口按天给出统计", async (ctx) => {
    if (!available) ctx.skip();
    const response = await fetch(`${baseUrl}/api/audit/log/summary?range=30d`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; days: unknown[] };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.days.length).toBeGreaterThanOrEqual(1);
  });

  it("导出：建任务立即返回 jobId（任务本身异步）", async (ctx) => {
    if (!available) ctx.skip();
    const response = await fetch(`${baseUrl}/api/audit/log/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: marker }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { job: { id: string; status: string } };
    expect(body.job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]).toContain(body.job.status);
  });
});
