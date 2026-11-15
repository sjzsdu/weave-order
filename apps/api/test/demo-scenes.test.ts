import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  demoScenesEnabled,
  findRepoRoot,
  loadDemoScenes,
  resolveSceneFromQueue,
} from "../src/demo/scene-catalog";
import { demoSceneByKey } from "@weave-order/schema";
import type { ApprovalItem } from "@weave-order/schema";
import { loadEnv } from "../src/platform/env";

function approval(overrides: Partial<ApprovalItem>): ApprovalItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "quote",
    title: "报价单",
    summary: "1 行",
    status: "DRAFT",
    pending: true,
    amountCents: 100,
    currency: "CNY",
    customerId: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-11-12T00:00:00.000Z",
    confirmedBy: null,
    version: 1,
    requiredRole: "MANAGER",
    requiredLevel: null,
    escalated: false,
    escalationReasons: [],
    changePctBps: null,
    diff: [],
    requirement: null,
    ...overrides,
  };
}

describe("剧本目录", () => {
  it("从仓库任意深度都能找到 data/demo-scenes.json", () => {
    const root = findRepoRoot();
    // 不要断言目录名叫 weave-order：检出目录可以随意命名（评审机、CI 缓存目录都会变）。
    // 断言「仓库根的特征文件」而不是路径字符串。
    expect(existsSync(path.join(root, "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(path.join(root, "data/demo-scenes.json"))).toBe(true);
    expect(loadDemoScenes().length).toBeGreaterThanOrEqual(2);
  });

  it("按锚点从审批队列里取最早的一张，忽略其它客户与单据类型", () => {
    const scene = demoSceneByKey(loadDemoScenes(), "approval-pending");
    if (!scene) throw new Error("缺少 approval-pending 剧本");
    const customerId = "22222222-2222-4222-8222-222222222222";
    const items = [
      approval({ id: "33333333-3333-4333-8333-333333333333", createdAt: "2026-11-10T00:00:00Z" }),
      approval({ id: "44444444-4444-4444-8444-444444444444", createdAt: "2026-11-11T00:00:00Z" }),
      approval({
        id: "55555555-5555-4555-8555-555555555555",
        kind: "sample_shipment",
        createdAt: "2026-11-09T00:00:00Z",
      }),
      approval({
        id: "66666666-6666-4666-8666-666666666666",
        customerId: "99999999-9999-4999-8999-999999999999",
        createdAt: "2026-11-08T00:00:00Z",
      }),
    ];
    expect(resolveSceneFromQueue(scene, customerId, items).entityId).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
  });

  it("找不到锚点返回 null（前端提示先 demo:reset，而不是白屏）", () => {
    const scene = demoSceneByKey(loadDemoScenes(), "approval-pending");
    if (!scene) throw new Error("缺少 approval-pending 剧本");
    expect(resolveSceneFromQueue(scene, null, []).entityId).toBeNull();
    expect(
      resolveSceneFromQueue(scene, "22222222-2222-4222-8222-222222222222", []).entityId,
    ).toBeNull();
  });
});

describe("剧本接口的装配条件", () => {
  it("本地 dev 与 WEAVE_ENV=test 装配；生产不装配", () => {
    expect(demoScenesEnabled({ NODE_ENV: "development", AUTH_MODE: "dev" })).toBe(true);
    expect(
      demoScenesEnabled({ NODE_ENV: "production", AUTH_MODE: "oidc", WEAVE_ENV: "test" }),
    ).toBe(true);
    expect(demoScenesEnabled({ NODE_ENV: "production", AUTH_MODE: "oidc" })).toBe(false);
    expect(
      demoScenesEnabled({ NODE_ENV: "production", AUTH_MODE: "oidc", WEAVE_ENV: "production" }),
    ).toBe(false);
  });
});

describe("WEAVE_ENV=test 必须与生产同构", () => {
  it("AUTH_MODE=dev 时 loadEnv 拒绝启动", () => {
    const previous = { ...process.env };
    vi.resetModules();
    try {
      expect(() =>
        loadEnv({
          NODE_ENV: "development",
          AUTH_MODE: "dev",
          WEAVE_ENV: "test",
          QUOTE_SHARE_SECRET: "x".repeat(40),
        }),
      ).toThrow(/WEAVE_ENV=test 必须与生产同构/);
    } finally {
      process.env = previous;
    }
  });

  it("生产同构时通过（仍需真实 secret）", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      AUTH_MODE: "oidc",
      WEAVE_ENV: "test",
      QUOTE_SHARE_SECRET: "x".repeat(40),
      PERSONAL_TOKEN_PEPPER: "y".repeat(20),
      PRINT_AGENT_SECRET: "z".repeat(40),
      ONBOARDING_SECRET: "o".repeat(40),
      APP_DATABASE_URL: "postgres://weave_app:weave_app@localhost:5433/weave_order",
      PUBLIC_APP_URL: "https://weave-test.wnbgj.com",
      WEB_APP_URL: "https://weave-test.wnbgj.com",
      S3_FORCE_PATH_STYLE: "false",
      S3_ACCESS_KEY_ID: "real-key",
      S3_SECRET_ACCESS_KEY: "real-secret",
      PLATFORM_API_URL: "https://platform.wnbgj.com",
      NOTIFY_PROVIDER: "webhook",
      NOTIFY_WEBHOOK_URL: "https://notify.wnbgj.com/send",
      DATABASE_URL: "postgres://weave_app:weave_app@localhost:5433/weave_order",
      REDIS_URL: "redis://localhost:6380",
    });
    expect(env.WEAVE_ENV).toBe("test");
  });
});

/**
 * 生产镜像里路由必须「不存在」，而不是「存在但 403」。
 * 与 WAN-136 的 dev persona 用例同一手法：在模块加载前定环境，再读装饰器元数据。
 */
describe("HttpModule 的剧本控制器按部署形态装配", () => {
  async function controllersWith(env: {
    NODE_ENV: string;
    AUTH_MODE: string;
    WEAVE_ENV?: string;
  }): Promise<unknown[]> {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      AUTH_MODE: process.env.AUTH_MODE,
      WEAVE_ENV: process.env.WEAVE_ENV,
    };
    process.env.NODE_ENV = env.NODE_ENV;
    process.env.AUTH_MODE = env.AUTH_MODE;
    if (env.WEAVE_ENV === undefined) delete process.env.WEAVE_ENV;
    else process.env.WEAVE_ENV = env.WEAVE_ENV;
    vi.resetModules();
    try {
      const { HttpModule } = await import("../src/http/http.module");
      const { DemoScenesController } = await import("../src/demo/scenes.controller");
      const controllers = (Reflect.getMetadata("controllers", HttpModule) ?? []) as unknown[];
      return controllers.includes(DemoScenesController) ? ["demo"] : [];
    } finally {
      if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.NODE_ENV;
      if (previous.AUTH_MODE === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previous.AUTH_MODE;
      if (previous.WEAVE_ENV === undefined) delete process.env.WEAVE_ENV;
      else process.env.WEAVE_ENV = previous.WEAVE_ENV;
      vi.resetModules();
    }
  }

  it("本地 dev 装配", async () => {
    expect(await controllersWith({ NODE_ENV: "development", AUTH_MODE: "dev" })).toEqual(["demo"]);
  });

  it("测试环境（生产同构 + WEAVE_ENV=test）装配", async () => {
    expect(
      await controllersWith({ NODE_ENV: "production", AUTH_MODE: "oidc", WEAVE_ENV: "test" }),
    ).toEqual(["demo"]);
  });

  it("生产（无 WEAVE_ENV）不装配：路由 404 的前提", async () => {
    expect(await controllersWith({ NODE_ENV: "production", AUTH_MODE: "oidc" })).toEqual([]);
  });
});
