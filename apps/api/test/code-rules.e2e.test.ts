import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { CodeRule, CodeRuleListResponse, CodeRulePreviewResult } from "@weave-order/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * 编号规则 HTTP 面端到端：真实 Nest + 真实 PG。
 *
 * 这里验证的是「web 设置页实际打到的那四个端点」，不是内核方法本身
 * （生成 / 并发 / RLS 另有 code-number*.integration.test.ts 覆盖）。
 * 没有本地 PG 时整组跳过，离线 `pnpm test` 仍全绿。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

let app: INestApplication | null = null;
let baseUrl = "";
let db: Db | null = null;
let pool: { end: () => Promise<void> } | null = null;
let available = false;

beforeAll(async () => {
  try {
    const handle = createDb(DATABASE_URL);
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.code_rules') IS NOT NULL AND to_regclass('public.code_counters') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (!available) {
      await handle.pool.end();
      return;
    }
    db = handle.db;
    pool = handle.pool;
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    const address = (app.getHttpServer() as Server).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("响应不是对象");
  return value as Record<string, unknown>;
}

describe("编号规则 HTTP（e2e）", () => {
  it("列表返回五类实体规则与四套内置预设", async (ctx) => {
    if (!available) ctx.skip();
    const { status, body } = await json("/api/code-rules");
    expect(status).toBe(200);
    const parsed = CodeRuleListResponse.parse(body);
    expect(parsed.rules.map((rule) => rule.entityType).sort()).toEqual(
      ["customer", "order", "quote", "sample", "sample_shipment"].sort(),
    );
    expect(parsed.presets.map((preset) => preset.key)).toEqual([
      "classic",
      "compact",
      "yearly",
      "plain",
    ]);
    // 不断言具体默认值：未配置时 list() 回退虚拟 classic，已配置时是租户自定义模板，
    // 两者都合法。默认模板逐字节兼容性由 code-number.integration.test.ts 覆盖。
    expect(
      parsed.rules.every((rule) => typeof rule.template === "string" && rule.template.length > 0),
    ).toBe(true);
  });

  it("预览不写库：合法模板给示例，非法模板只报错", async (ctx) => {
    if (!available) ctx.skip();
    const good = await json(
      `/api/code-rules/preview?${new URLSearchParams({ entityType: "sample", template: "S{YYMMDD}-{SEQ:4}" }).toString()}`,
    );
    expect(good.status).toBe(200);
    const goodResult = CodeRulePreviewResult.parse(good.body);
    expect(goodResult.valid).toBe(true);
    expect(goodResult.examples).toHaveLength(3);
    expect(goodResult.examples[0]?.bytes).toBeLessThanOrEqual(goodResult.maxBytes);

    const bad = await json(
      `/api/code-rules/preview?${new URLSearchParams({ entityType: "sample", template: "S-{UNKNOWN}-{SEQ:4}" }).toString()}`,
    );
    expect(bad.status).toBe(200);
    const badResult = CodeRulePreviewResult.parse(bad.body);
    expect(badResult.valid).toBe(false);
    expect(badResult.errors.map((error) => error.code)).toContain(
      "CODE_TEMPLATE_UNKNOWN_PLACEHOLDER",
    );
  });

  it("保存 → 读取生效 → 写审计 → 恢复默认", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const kernel = createKernel(database);
    const since = new Date(Date.now() - 1_000);

    const saved = await json("/api/code-rules/customer", {
      method: "PUT",
      body: JSON.stringify({ template: "KH-{YYYYMM}-{SEQ:4}", presetKey: null }),
    });

    try {
      expect(saved.status).toBe(200);
      expect(CodeRule.parse(asRecord(saved.body).rule).template).toBe("KH-{YYYYMM}-{SEQ:4}");
      const list = await json("/api/code-rules");
      const customer = CodeRuleListResponse.parse(list.body).rules.find(
        (rule) => rule.entityType === "customer",
      );
      expect(customer?.template).toBe("KH-{YYYYMM}-{SEQ:4}");
      expect(customer?.presetKey).toBeNull();

      const auditCount = await kernel.audit.count({
        since,
        actions: ["CODE_RULE_SAVED"],
      });
      expect(auditCount).toBeGreaterThanOrEqual(1);
    } finally {
      const restored = await json("/api/code-rules/customer/reset", { method: "POST" });
      expect(restored.status).toBe(201);
      expect(CodeRule.parse(asRecord(restored.body).rule).template).toBe("C{YYMMDD}-{SEQ:4}");
    }
  });

  it("非法模板保存被拒，不覆盖已有规则", async (ctx) => {
    if (!available) ctx.skip();
    const rejected = await json("/api/code-rules/order", {
      method: "PUT",
      body: JSON.stringify({ template: "DD-{SEQ:4}-{SEQ:2}" }),
    });
    expect(rejected.status).toBe(400);

    const list = await json("/api/code-rules");
    const order = CodeRuleListResponse.parse(list.body).rules.find(
      (rule) => rule.entityType === "order",
    );
    expect(order?.template).toBe("DD{YYMMDD}-{SEQ:4}");
  });

  it("未知实体在路径上被拒 400", async (ctx) => {
    if (!available) ctx.skip();
    const { status } = await json("/api/code-rules/not-an-entity/reset", { method: "POST" });
    expect(status).toBe(400);
  });

  it("内核层拒绝无 settings.edit 的角色改规则", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const kernel = createKernel(database);
    const sales: KernelContext = {
      actor: { type: "HUMAN", id: "code-rules-e2e-sales", role: "SALES" },
    };
    await expect(
      kernel.codeNumber.save(
        { entityType: "sample", template: "X{SEQ:4}", presetKey: null },
        sales,
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
