import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/** 从 /config.js 的响应脚本里取出下发的 JSON 配置。 */
async function runtimeConfig(): Promise<{ productionLike?: boolean }> {
  const body = await GET().text();
  const match = /window\.__WEAVE_CONFIG__=(\{.*?\});/.exec(body);
  if (!match) throw new Error(`意外的 /config.js 内容：${body}`);
  return JSON.parse(match[1]!) as { productionLike?: boolean };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * 客户端读不到 AUTH_MODE，生产态只能由服务端现算后经 /config.js 下发。
 * 这里锁定「staging 与生产同判」：NODE_ENV=development 但 AUTH_MODE=oidc 时，
 * 浏览器拿到的 productionLike 必须是 true，否则 staging 会放开演示模式。
 */
describe("/config.js 下发生产态判定", () => {
  it("生产：NODE_ENV=production + AUTH_MODE=oidc → productionLike=true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_MODE", "oidc");

    const config = await runtimeConfig();
    expect(config.productionLike).toBe(true);
  });

  it("staging：NODE_ENV=development + AUTH_MODE=oidc → productionLike=true", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_MODE", "oidc");

    const config = await runtimeConfig();
    expect(config.productionLike).toBe(true);
  });

  it("本地 dev：NODE_ENV=development + AUTH_MODE=dev → productionLike=false", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_MODE", "dev");

    const config = await runtimeConfig();
    expect(config.productionLike).toBe(false);
  });

  it("配置不缓存：同一进程内改环境变量立即生效", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_MODE", "dev");
    expect((await runtimeConfig()).productionLike).toBe(false);

    vi.stubEnv("AUTH_MODE", "oidc");
    expect((await runtimeConfig()).productionLike).toBe(true);
  });
});
