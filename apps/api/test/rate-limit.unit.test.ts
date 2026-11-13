import { afterEach, describe, expect, it } from "vitest";
import { PUBLIC_QUOTE_RATE_LIMITS, PublicRateLimitService } from "../src/platform/rate-limit";

/**
 * 限流单元测试：强制使用进程内存储（redisUrl=null），不依赖 Redis。
 * 重点验证 IP / token 双维度、阈值边界与窗口重置语义。
 */
const services: PublicRateLimitService[] = [];

function service(): PublicRateLimitService {
  const created = new PublicRateLimitService("test-rate-limit-secret", null);
  services.push(created);
  return created;
}

afterEach(() => {
  for (const entry of services.splice(0)) entry.onApplicationShutdown();
});

describe("公开报价链接限流", () => {
  it("同一 IP 对同一链接超过 view 阈值才拒绝（第 61 次 429）", async () => {
    const limiter = service();
    const { limit } = PUBLIC_QUOTE_RATE_LIMITS.view.ip;

    for (let index = 0; index < limit; index += 1) {
      expect(await limiter.check("view", "203.0.113.10", "token-a")).toBeNull();
    }
    const denial = await limiter.check("view", "203.0.113.10", "token-a");
    expect(denial?.dimension).toBe("ip");
    expect(denial?.limit).toBe(limit);
    expect(denial?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("换 IP 后同一 token 仍受 token 维度约束", async () => {
    const limiter = service();
    const { limit } = PUBLIC_QUOTE_RATE_LIMITS.view.token;

    for (let index = 0; index < limit; index += 1) {
      // 每次换 IP，确保只有 token 维度在计数。
      expect(await limiter.check("view", `198.51.100.${index % 250}`, "token-b")).toBeNull();
    }
    const denial = await limiter.check("view", "198.51.100.250", "token-b");
    expect(denial?.dimension).toBe("token");
  });

  it("不同链接 / 不同动作互不污染", async () => {
    const limiter = service();
    const { limit } = PUBLIC_QUOTE_RATE_LIMITS.accept.ip;

    for (let index = 0; index < limit; index += 1) {
      expect(await limiter.check("accept", "203.0.113.20", "token-c")).toBeNull();
    }
    expect(await limiter.check("accept", "203.0.113.20", "token-c")).not.toBeNull();
    // 同一 IP 换一条链接仍然受 IP 维度约束（这是设计目标：防单机刷所有泄露链接）。
    expect(await limiter.check("accept", "203.0.113.20", "token-d")).not.toBeNull();
    // 另一个动作从零开始计数。
    expect(await limiter.check("pdf", "203.0.113.20", "token-c")).toBeNull();
  });

  it("无 IP 的请求按 unknown 归并，而不是绕开限流", async () => {
    const limiter = service();
    const { limit } = PUBLIC_QUOTE_RATE_LIMITS.questions.ip;

    for (let index = 0; index < limit; index += 1) {
      expect(await limiter.check("questions", undefined, `token-${index}`)).toBeNull();
    }
    const denial = await limiter.check("questions", undefined, "token-final");
    expect(denial?.dimension).toBe("ip");
  });
});
