import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsService } from "../src/control/settings.service";
import { LlmSettingsController } from "../src/http/settings.controllers";
import { PERMISSIONS_KEY } from "../src/auth/decorators";
import { can } from "../src/domain/permissions";
import { AccountExecutor } from "./helpers/actor";

/**
 * WAN-94：`POST /settings/llm/test` 收口。
 *
 * - `keyRef` 白名单外（如 DATABASE_URL）→ 403，且 fetch 从未被调用（不泄漏任何环境变量）；
 * - `baseUrl` 白名单外 → 403，不出网；
 * - 合法目标 → 出网一次、每次调用写审计，审计里不含密钥；
 * - 路由权限为 `llm:write`（platform_readonly 不可调）。
 */

const actor = AccountExecutor("wan94-ops", "platform_ops");
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined) {
  savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function makeService(rows: unknown[]) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => Promise.resolve(rows)) })),
  };
  const service = new SettingsService(
    db as unknown as ConstructorParameters<typeof SettingsService>[0],
    audit as unknown as ConstructorParameters<typeof SettingsService>[1],
  );
  return { service, audit, db };
}

/** 全局行：控制面 llm_settings 里已保存的网关地址（服务端配置的一部分）。 */
function globalRow(baseUrl: string | null = "http://litellm.internal:4000") {
  return { scope: "GLOBAL", tenantId: null, baseUrl };
}

beforeEach(() => {
  setEnv("LITELLM_BASE_URL", undefined);
  setEnv("LLM_ALLOWED_BASE_URLS", undefined);
  setEnv("LITELLM_TENANT_KEY_T_0001", "sk-tenant-secret-test");
  setEnv("DATABASE_URL", "postgres://canary-leak-value@localhost:5433/weave_order");
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("llm/test keyRef 白名单", () => {
  it("keyRef=DATABASE_URL 必须失败（403），且不发出任何出网请求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { service, audit } = makeService([globalRow()]);

    const attempt = service.testLlm(actor, {
      baseUrl: "http://litellm.internal:4000",
      keyRef: "DATABASE_URL",
    });
    await expect(attempt).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(attempt).rejects.toThrow(/白名单/);
    expect(fetchSpy).not.toHaveBeenCalled();

    // 拒绝本身也要留痕：谁、想测什么地址、为什么拒绝。
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0]?.[1]).toMatchObject({
      action: "LLM_GATEWAY_TESTED",
      reason: "LLM 网关连通性测试",
    });
    // 任何一侧（审计 / fetch 调用）都不能出现密钥值。
    const everything = JSON.stringify([audit.record.mock.calls, fetchSpy.mock.calls]);
    expect(everything).not.toContain("canary-leak-value");
  });

  it("白名单 keyRef 命中时按 Bearer 出网，审计含目标与结果但不含密钥", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
    const { service, audit } = makeService([globalRow()]);

    const result = await service.testLlm(actor, {
      baseUrl: "http://litellm.internal:4000/",
      keyRef: "LITELLM_TENANT_KEY_T_0001",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://litellm.internal:4000/health/liveliness");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-tenant-secret-test",
    );

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [auditActor, auditInput] = audit.record.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(auditActor).toMatchObject({ sub: "wan94-ops", role: "platform_ops" });
    expect(auditInput.action).toBe("LLM_GATEWAY_TESTED");
    expect(auditInput.targetId).toBe("http://litellm.internal:4000");
    expect(auditInput.after).toMatchObject({ ok: true, status: 200 });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("sk-tenant-secret-test");
  });
});

describe("llm/test baseUrl 白名单", () => {
  it("白名单外/非法 scheme 的 baseUrl 一律 403，且 fetch 从未被调用", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { service } = makeService([globalRow()]);

    const evil = [
      "http://127.0.0.1:4010",
      "http://evil.example.com",
      "file:///etc/passwd",
      "http://litellm.internal:4000@evil.example.com",
      "https://litellm.internal.evil.example.com",
      "not-a-url",
    ];
    for (const baseUrl of evil) {
      const attempt = service.testLlm(actor, { baseUrl });
      await expect(attempt).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      await expect(attempt).rejects.toThrow(/白名单/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("未带 baseUrl 时用服务端已配置地址（本身就是白名单来源）", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
    const { service } = makeService([globalRow()]);

    const result = await service.testLlm(actor, {});
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://litellm.internal:4000/health/liveliness");
  });

  it("LITELLM_BASE_URL 与运维放行的 LLM_ALLOWED_BASE_URLS 同样在白名单内", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchSpy);
    setEnv("LITELLM_BASE_URL", "http://localhost:4000");
    setEnv("LLM_ALLOWED_BASE_URLS", "http://extra.gateway:8080, https://gw.example.com");
    const { service } = makeService([globalRow(null)]);

    const viaEnv = await service.testLlm(actor, { baseUrl: "http://localhost:4000" });
    expect(viaEnv.ok).toBe(false);
    expect(viaEnv.status).toBe(503);
    const viaAllowList = await service.testLlm(actor, { baseUrl: "https://gw.example.com" });
    expect(viaAllowList.ok).toBe(false);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://localhost:4000/health/liveliness");
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://gw.example.com/health/liveliness");
  });
});

describe("llm/test 路由权限", () => {
  it("POST /settings/llm/test 要求 llm:write；platform_readonly 没有该权限", () => {
    // SetMetadata 对方法装饰器把元数据写在 handler 函数本身（Reflector 也从 handler 读）。
    // eslint-disable-next-line @typescript-eslint/unbound-method -- 读取 handler 元数据必须拿到方法本身
    const handler = LlmSettingsController.prototype.test;
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(["llm:write"]);
    expect(can("platform_readonly", "llm:write")).toBe(false);
    expect(can("platform_ops", "llm:write")).toBe(true);
    expect(can("platform_owner", "llm:write")).toBe(true);
  });
});
