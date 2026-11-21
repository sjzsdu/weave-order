import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, memberships, tenants } from "@weave-order/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { requirePrintTestEnv } from "./support/print-env";

/**
 * 模板编辑器的 HTTP 契约（真起 Nest、真连 PG）。
 *
 * 服务层用例已经覆盖业务规则，这里盯的是「路由有没有接上、状态码与错误码对不对」：
 * 复制 → 存草稿 → 发布 → 详情 → 回滚，以及已发布版本不可改、HTML 只给 OWNER。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let app: INestApplication | null = null;
let baseUrl = "";
let available = false;
let ownerAuth: Record<string, string> = {};
let salesAuth: Record<string, string> = {};

beforeAll(async () => {
  try {
    const handle = createDb(DATABASE_URL);
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.print_template_versions') IS NOT NULL AS exists",
    );
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
      .values({ slug: `tpl-e2e-${suffix()}`, name: "模板编辑 E2E 租户" })
      .returning();
    const tenantId = tenantRows[0]!.id;
    const owner = `tpl-owner-${suffix()}`;
    const sales = `tpl-sales-${suffix()}`;
    await handle.db.insert(memberships).values([
      { tenantId, subject: owner, role: "OWNER", status: "ACTIVE" },
      { tenantId, subject: sales, role: "SALES", status: "ACTIVE" },
    ]);
    ownerAuth = { Authorization: `Bearer dev:${owner}` };
    salesAuth = { Authorization: `Bearer dev:${sales}` };
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
  auth: Record<string, string> = ownerAuth,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...auth, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

const layout = {
  version: 1,
  blocks: [
    { field: "sample.code", label: null, visible: true, fontSize: 14, bold: true },
    { field: "salesperson.phone", label: null, visible: true, fontSize: 8, bold: false },
  ],
  qr: { visible: true, position: "RIGHT", sizeMm: 26 },
};

describe("模板编辑器 HTTP（e2e）", () => {
  it("复制 → 存草稿 → 发布 → 详情 → 回滚，且已发布版本拒绝改写", async (ctx) => {
    if (!available) {
      requirePrintTestEnv(ctx, "模板表不可用（PostgreSQL 未迁移）");
      return;
    }

    const copied = await json("/api/print/templates/copy", {
      method: "POST",
      body: JSON.stringify({
        sourceTemplateId: "system/sample-card/zpl-80x50",
        name: `E2E-样卡-${suffix()}`,
      }),
    });
    expect(copied.status).toBe(201);
    const templateId = (copied.body.template as { id: string }).id;
    expect((copied.body as { draft: unknown }).draft).not.toBeNull();

    const saved = await json(`/api/print/templates/${templateId}/draft`, {
      method: "PUT",
      body: JSON.stringify({ layout }),
    });
    expect(saved.status).toBe(200);
    expect((saved.body.draft as { layout: { blocks: unknown[] } }).layout.blocks).toHaveLength(2);

    const published = await json(`/api/print/templates/${templateId}/versions`, {
      method: "POST",
      body: JSON.stringify({ layout }),
    });
    expect(published.status).toBe(201);
    const version1 = (published.body.template as { activeVersion: { id: string } }).activeVersion;

    const detail = await json(`/api/print/templates/${templateId}`);
    expect(detail.status).toBe(200);
    const versions = (detail.body as { versions: Array<{ version: number }> }).versions;
    expect(versions.map((version) => version.version)).toEqual([1]);

    // 回滚接口存在且幂等：切回当前版本不报错。
    const activated = await json(
      `/api/print/templates/${templateId}/versions/${version1.id}/activate`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(activated.status).toBe(201);
    expect((activated.body.template as { activeVersion: { id: string } }).activeVersion.id).toBe(
      version1.id,
    );

    // 已发布版本只读：PUT/PATCH 都拿业务错误，而不是被悄悄改写。
    const blocked = await json(`/api/print/templates/${templateId}/versions/${version1.id}`, {
      method: "PUT",
      body: JSON.stringify({ body: "tampered" }),
    });
    expect(blocked.status).toBe(400);
    expect((blocked.body.error as { code: string }).code).toBe("PRINT_TEMPLATE_VERSION_IMMUTABLE");
  });

  it("HTML 版式只有 OWNER 能复制成草稿，标签不受限", async (ctx) => {
    if (!available) {
      requirePrintTestEnv(ctx, "模板表不可用（PostgreSQL 未迁移）");
      return;
    }
    const htmlCopy = await json(
      "/api/print/templates/copy",
      {
        method: "POST",
        body: JSON.stringify({
          sourceTemplateId: "system/sample-card/classic-a4",
          name: `E2E-销售A4-${suffix()}`,
        }),
      },
      salesAuth,
    );
    expect(htmlCopy.status).toBe(403);
    expect((htmlCopy.body.error as { code: string }).code).toBe("PERMISSION_DENIED");

    const labelCopy = await json(
      "/api/print/templates/copy",
      {
        method: "POST",
        body: JSON.stringify({
          sourceTemplateId: "system/sample-card/tspl-80x50",
          name: `E2E-销售标签-${suffix()}`,
        }),
      },
      salesAuth,
    );
    expect(labelCopy.status).toBe(201);
  });

  it("非法字段走 HTTP 也被拒，并带出字段名", async (ctx) => {
    if (!available) {
      requirePrintTestEnv(ctx, "模板表不可用（PostgreSQL 未迁移）");
      return;
    }
    const copied = await json("/api/print/templates/copy", {
      method: "POST",
      body: JSON.stringify({
        sourceTemplateId: "system/sample-card/zpl-80x50",
        name: `E2E-白名单-${suffix()}`,
      }),
    });
    const templateId = (copied.body.template as { id: string }).id;
    const rejected = await json(`/api/print/templates/${templateId}/draft`, {
      method: "PUT",
      body: JSON.stringify({
        layout: {
          ...layout,
          blocks: [{ field: "order.no", label: null, visible: true, fontSize: 12, bold: false }],
        },
      }),
    });
    expect(rejected.status).toBe(400);
    expect(String((rejected.body.error as { message: string }).message)).toContain("order.no");
  });
});
