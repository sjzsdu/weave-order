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
 * - `keyRef` 白名单外（如 DATABASE_URL / LITELLM_MASTER_KEY）→ 403，且 fetch 从未被调用；
 * - `baseUrl` 白名单外 → 403，不出网；
 * - 合法目标 → `GET /models`，携带 Bearer Key，只验证网关/鉴权/模型列表，不发送业务数据；
 * - 401/403、404、超时、非 2xx、异常响应都返回明确错误，每次尝试写审计且不含密钥；
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
function globalRow(baseUrl: string | null = "https://gateway.example.test:4000/v1") {
  return { scope: "GLOBAL", tenantId: null, baseUrl };
}

function modelsResponse(models = ["daily-model", "reason-model", "vision-model"]) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ object: "list", data: models.map((id) => ({ id })) }),
  };
}

beforeEach(() => {
  setEnv("LLM_BASE_URL", undefined);
  setEnv("LLM_ALLOWED_BASE_URLS", undefined);
  setEnv("LLM_API_KEY", "sk-gateway-test");
  setEnv("LLM_TENANT_KEY_T_0001", "sk-tenant-secret-test");
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
  it("keyRef=DATABASE_URL / LITELLM_* 必须失败（403），且不发出任何出网请求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const keyRef of ["DATABASE_URL", "LITELLM_MASTER_KEY", "OPENAI_API_KEY"]) {
      const { service, audit } = makeService([globalRow()]);
      const attempt = service.testLlm(actor, {
        baseUrl: "https://gateway.example.test:4000/v1",
        keyRef,
      });
      await expect(attempt).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      await expect(attempt).rejects.toThrow(/白名单/);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0]?.[1]).toMatchObject({
        action: "LLM_GATEWAY_TESTED",
        reason: "LLM 网关连通性测试",
      });
    }
    // 任何一侧（审计 / fetch 调用）都不能出现密钥值。
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain("canary-leak-value");
  });

  it("白名单 keyRef 命中时按 Bearer 请求 /models，审计含目标与结果但不含密钥", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(modelsResponse());
    vi.stubGlobal("fetch", fetchSpy);
    const { service, audit } = makeService([globalRow()]);

    const result = await service.testLlm(actor, {
      baseUrl: "https://gateway.example.test:4000/v1/",
      keyRef: "LLM_TENANT_KEY_T_0001",
    });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(result.message).toContain("3 个模型");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gateway.example.test:4000/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-tenant-secret-test",
    );
    expect(init.body).toBeUndefined();
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [auditActor, auditInput] = audit.record.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(auditActor).toMatchObject({ sub: "wan94-ops", role: "platform_ops" });
    expect(auditInput.action).toBe("LLM_GATEWAY_TESTED");
    expect(auditInput.targetId).toBe("https://gateway.example.test:4000/v1");
    expect(auditInput.after).toMatchObject({ ok: true, status: 200 });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("sk-tenant-secret-test");
  });

  it("未带 keyRef 时使用默认 LLM_API_KEY", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(modelsResponse([]));
    vi.stubGlobal("fetch", fetchSpy);
    const { service } = makeService([globalRow()]);
    await service.testLlm(actor, {});
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-gateway-test");
  });

  it("Key 未命中时 fail closed，审计留痕且不出网", async () => {
    setEnv("LLM_API_KEY", undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { service, audit } = makeService([globalRow()]);
    const result = await service.testLlm(actor, {});
    expect(result.ok).toBe(false);
    expect(result.message).toContain("LLM_API_KEY");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
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
      "https://gateway.example.test:4000@evil.example.com",
      "https://gateway.example.test.evil.example.com",
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
    const fetchSpy = vi.fn().mockResolvedValue(modelsResponse());
    vi.stubGlobal("fetch", fetchSpy);
    const { service } = makeService([globalRow()]);

    const result = await service.testLlm(actor, {});
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://gateway.example.test:4000/v1/models");
  });

  it("未配置任何地址时明确失败，不把进程存活误报为成功", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { service, audit } = makeService([globalRow(null)]);
    const result = await service.testLlm(actor, {});
    expect(result.ok).toBe(false);
    expect(result.message).toContain("LLM_BASE_URL");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it("LLM_BASE_URL 与运维放行的 LLM_ALLOWED_BASE_URLS 同样在白名单内", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchSpy);
    setEnv("LLM_BASE_URL", "https://gateway.example.test/v1");
    setEnv("LLM_ALLOWED_BASE_URLS", "https://extra-gw.example.com/v1, https://gw.example.com/v1");
    const { service } = makeService([globalRow(null)]);

    const viaEnv = await service.testLlm(actor, { baseUrl: "https://gateway.example.test/v1/" });
    expect(viaEnv.ok).toBe(false);
    expect(viaEnv.status).toBe(503);
    const viaAllowList = await service.testLlm(actor, {
      baseUrl: "https://gw.example.com/v1",
    });
    expect(viaAllowList.ok).toBe(false);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://gateway.example.test/v1/models");
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://gw.example.com/v1/models");
  });
});

describe("llm/test 错误分支", () => {
  const cases = [
    {
      name: "401 鉴权失败",
      response: { ok: false, status: 401 },
      expectMessage: /鉴权失败/,
      expectStatus: 401,
    },
    {
      name: "403 鉴权失败",
      response: { ok: false, status: 403 },
      expectMessage: /鉴权失败/,
      expectStatus: 403,
    },
    {
      name: "404 非 OpenAI 兼容地址",
      response: { ok: false, status: 404 },
      expectMessage: /404/,
      expectStatus: 404,
    },
    {
      name: "500 非 2xx",
      response: { ok: false, status: 500 },
      expectMessage: /HTTP 500/,
      expectStatus: 500,
    },
    {
      name: "非 JSON 响应",
      response: {
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("not json")),
      },
      expectMessage: /未返回 JSON/,
      expectStatus: 200,
    },
    {
      name: "缺少模型列表",
      response: { ok: true, status: 200, json: () => Promise.resolve({ object: "list" }) },
      expectMessage: /模型列表/,
      expectStatus: 200,
    },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.name} 返回明确错误且写审计`, async () => {
      const fetchSpy = vi.fn().mockResolvedValue(testCase.response);
      vi.stubGlobal("fetch", fetchSpy);
      const { service, audit } = makeService([globalRow()]);
      const result = await service.testLlm(actor, {});
      expect(result.ok).toBe(false);
      expect(result.status).toBe(testCase.expectStatus);
      expect(result.message).toMatch(testCase.expectMessage);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain("sk-gateway-test");
    });
  }

  it("超时（4 秒）返回明确错误", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const fetchSpy = vi.fn().mockRejectedValue(timeout);
    vi.stubGlobal("fetch", fetchSpy);
    const { service, audit } = makeService([globalRow()]);
    const result = await service.testLlm(actor, {});
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.message).toMatch(/超时/);
    expect(audit.record).toHaveBeenCalledTimes(1);
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
