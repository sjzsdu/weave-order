import { Injectable, Logger } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { createHmac } from "node:crypto";
import Redis from "ioredis";
import { loadEnv } from "./env";

/**
 * 公开报价链接的限流。
 *
 * 公开路由是唯一对公网开放写的入口，必须同时按 **IP** 与 **token** 两个维度限流：
 * - 只按 IP：一个共享出口 NAT 后的正常客户会被邻居拖累，换个代理即可绕过；
 * - 只按 token：单个机器人可以刷爆所有泄露的链接。
 *
 * 存储优先用已有的 Redis（多实例共享计数）；Redis 不可用时退回进程内固定窗口，
 * 保证单实例仍然有保护，而不是把限流变成“Redis 挂了就全放行”。
 * IP 与 token 都先做 HMAC 再进 Redis，不把明文客户端信息写进缓存。
 *
 * 部署前提：客户端 IP 取自 `x-forwarded-for` 第一跳（与访客哈希同一口径），
 * 反向代理必须覆盖而不是透传该头，否则伪造 XFF 可绕开 IP 维度；
 * token 维度仍然限制单条链接的总量。
 */

export type PublicQuoteAction = "view" | "accept" | "questions" | "pdf";

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface PublicRateLimitRuleSet {
  ip: RateLimitRule;
  token: RateLimitRule;
}

export const TENANT_START_RATE_LIMITS = {
  ip: { limit: 20, windowMs: 3_600_000 },
  sub: { limit: 3, windowMs: 3_600_000 },
} satisfies { ip: RateLimitRule; sub: RateLimitRule };

/**
 * 阈值（每分钟，固定窗口）。数值刻意宽松：
 * - `view` 允许正常客户反复刷新 / 多人共用一条链接；
 * - `accept` / `pdf` / `questions` 是低频写操作，收紧到个位数到几十次。
 * 超限统一 429 + `RATE_LIMITED`，并带 `Retry-After`。
 */
export const PUBLIC_QUOTE_RATE_LIMITS: Record<PublicQuoteAction, PublicRateLimitRuleSet> = {
  view: {
    ip: { limit: 60, windowMs: 60_000 },
    token: { limit: 300, windowMs: 60_000 },
  },
  accept: {
    ip: { limit: 10, windowMs: 60_000 },
    token: { limit: 20, windowMs: 60_000 },
  },
  questions: {
    ip: { limit: 20, windowMs: 60_000 },
    token: { limit: 30, windowMs: 60_000 },
  },
  pdf: {
    ip: { limit: 20, windowMs: 60_000 },
    token: { limit: 30, windowMs: 60_000 },
  },
};

export type RateLimitDimension = "ip" | "token" | "sub";

export interface RateLimitDenial {
  dimension: RateLimitDimension;
  limit: number;
  retryAfterSeconds: number;
}

interface WindowDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** 进程内固定窗口；map 大小有上限，过期桶在写入时顺带清理。 */
class MemoryFixedWindowStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly maxKeys = 50_000;

  hit(key: string, rule: RateLimitRule): WindowDecision {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      bucket = { count: 0, resetAt: now + rule.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= rule.limit) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    // 仍然满：最多删掉最旧的一批，保证内存有界（限流宁可放宽也不能吃爆进程）。
    if (this.buckets.size >= this.maxKeys) {
      let excess = this.buckets.size - Math.floor(this.maxKeys / 2);
      for (const key of this.buckets.keys()) {
        if (excess-- <= 0) break;
        this.buckets.delete(key);
      }
    }
  }
}

/** 原子 INCR + 首次 PEXPIRE，避免“先 INCR 后 EXPIRE”之间进程挂掉留下永不过期的键。 */
const REDIS_FIXED_WINDOW_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return {current, redis.call("PTTL", KEYS[1])}
`;

@Injectable()
export class PublicRateLimitService implements OnApplicationShutdown {
  private readonly logger = new Logger(PublicRateLimitService.name);
  private readonly memory = new MemoryFixedWindowStore();
  private readonly secret: string;
  private readonly redis: Redis | null;
  private redisUsable: boolean;

  constructor(
    secret: string = loadEnv().QUOTE_SHARE_SECRET,
    redisUrl: string | null = loadEnv().REDIS_URL,
  ) {
    this.secret = secret;
    this.redis = redisUrl ? this.connect(redisUrl) : null;
    this.redisUsable = this.redis !== null;
  }

  private connect(url: string): Redis | null {
    try {
      const client = new Redis(url, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1_500,
        // 不可用就彻底放弃重连，交给进程内存储兜底，避免后台无限重试刷日志。
        retryStrategy: () => null,
      });
      client.on("error", () => {
        // 具体错误只在第一次降级时记录，见 hitRedis。
      });
      return client;
    } catch (error) {
      this.logger.warn(
        `限流 Redis 初始化失败，改用进程内计数：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * 依次检查 IP 与 token；任一维度超限即返回拒绝信息。
   * 返回 null 表示放行。
   */
  async check(
    action: PublicQuoteAction,
    ip: string | undefined,
    token: string,
  ): Promise<RateLimitDenial | null> {
    const rules = PUBLIC_QUOTE_RATE_LIMITS[action];
    return this.checkDimensions(`public-quote:${action}`, [
      { dimension: "ip", value: ip ?? "unknown", rule: rules.ip },
      { dimension: "token", value: token, rule: rules.token },
    ]);
  }

  async checkTenantStart(ip: string | undefined, sub: string): Promise<RateLimitDenial | null> {
    return this.checkDimensions("tenant-start", [
      { dimension: "ip", value: ip ?? "unknown", rule: TENANT_START_RATE_LIMITS.ip },
      { dimension: "sub", value: sub, rule: TENANT_START_RATE_LIMITS.sub },
    ]);
  }

  private async checkDimensions(
    namespace: string,
    dimensions: Array<{ dimension: RateLimitDimension; value: string; rule: RateLimitRule }>,
  ): Promise<RateLimitDenial | null> {
    for (const entry of dimensions) {
      const key = this.key(namespace, entry.dimension, entry.value);
      const decision = (await this.hitRedis(key, entry.rule)) ?? this.memory.hit(key, entry.rule);
      if (!decision.allowed) {
        return {
          dimension: entry.dimension,
          limit: entry.rule.limit,
          retryAfterSeconds: decision.retryAfterSeconds,
        };
      }
    }
    return null;
  }

  private key(namespace: string, dimension: RateLimitDimension, value: string): string {
    const digest = createHmac("sha256", this.secret).update(value).digest("base64url");
    return `ratelimit:${namespace}:${dimension}:${digest}`;
  }

  private async hitRedis(key: string, rule: RateLimitRule): Promise<WindowDecision | null> {
    const client = this.redis;
    if (!client || !this.redisUsable) return null;
    try {
      if (client.status === "wait") await client.connect();
      const result = (await client.eval(
        REDIS_FIXED_WINDOW_SCRIPT,
        1,
        key,
        String(rule.windowMs),
      )) as [number | string, number | string];
      const count = Number(result[0]);
      if (!Number.isFinite(count)) return null;
      if (count <= rule.limit) return { allowed: true, retryAfterSeconds: 0 };
      const ttlMs = Math.max(0, Number(result[1]));
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
    } catch (error) {
      this.redisUsable = false;
      this.logger.warn(
        `限流 Redis 不可用，降级为进程内计数（多实例下计数不共享）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  onApplicationShutdown(): void {
    if (!this.redis) return;
    this.redisUsable = false;
    this.redis.disconnect();
  }
}
