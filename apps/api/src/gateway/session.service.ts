import { randomBytes } from "node:crypto";
import type Redis from "ioredis";
import { loadEnv } from "../platform/env";
import { connectRedis } from "../platform/redis";

/** 浏览器持有的会话 Cookie 名。值是不透明的 `sid`，不含任何身份或租户信息。 */
export const SESSION_COOKIE = "weave_sid";

/**
 * `SessionService` 的注入 token。
 *
 * 放在这里而不是 `gateway.module.ts`，避免「中间件 → gateway.module → auth.controller
 * → 中间件」的循环依赖把 token 求值成 undefined。
 */
export const TENANT_SESSIONS = Symbol("TENANT_SESSIONS");

/**
 * 会话记录。
 *
 * `tenantId = null` 表示「Casdoor 认证通过，但还没选租户」，这是多租户账号的
 * 中间态。业务请求永远不会看到这个状态：没有 tenantId 就没有内核作用域。
 */
export interface SessionRecord {
  sub: string;
  name: string | null;
  email: string | null;
  tenantId: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface SessionStore {
  get(sid: string): Promise<SessionRecord | null>;
  set(sid: string, record: SessionRecord, ttlSeconds: number): Promise<void>;
  delete(sid: string): Promise<void>;
}

/** Redis 会话：`weave:session:{sid}` → JSON，TTL 滑动续期。 */
export class RedisSessionStore implements SessionStore {
  constructor(private readonly client: Redis) {}

  async get(sid: string): Promise<SessionRecord | null> {
    const raw = await this.client.get(this.key(sid));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionRecord;
    } catch {
      // 损坏的会话按不存在处理：宁可让用户重新登录，也不猜身份。
      return null;
    }
  }

  async set(sid: string, record: SessionRecord, ttlSeconds: number): Promise<void> {
    await this.client.set(this.key(sid), JSON.stringify(record), "EX", ttlSeconds);
  }

  async delete(sid: string): Promise<void> {
    await this.client.del(this.key(sid));
  }

  private key(sid: string): string {
    return `weave:session:${sid}`;
  }
}

/** 进程内会话：本地开发 / 单元测试用；重启即失效，不能用于多实例部署。 */
export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, { record: SessionRecord; expiresAt: number }>();

  get(sid: string): Promise<SessionRecord | null> {
    const entry = this.records.get(sid);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt <= Date.now()) {
      this.records.delete(sid);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.record);
  }

  set(sid: string, record: SessionRecord, ttlSeconds: number): Promise<void> {
    this.records.set(sid, { record, expiresAt: Date.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  delete(sid: string): Promise<void> {
    this.records.delete(sid);
    return Promise.resolve();
  }
}

/**
 * 租户会话服务：`sid` 的签发、读取、绑定与吊销。
 *
 * 为什么是有状态会话而不是自签租户 JWT：`sid` 里没有租户，切换就是重绑一条
 * Redis 记录，吊销就是删 key，不需要第二套签名密钥与轮换流程（ADR-1）。
 */
export class SessionService {
  private readonly ttlSeconds: number;

  constructor(
    private readonly store: SessionStore,
    ttlSeconds?: number,
  ) {
    this.ttlSeconds = ttlSeconds ?? loadEnv().SESSION_TTL_SECONDS;
  }

  get ttl(): number {
    return this.ttlSeconds;
  }

  /** 新会话：sid 每次登录重新生成，避免会话固定。 */
  async create(input: {
    sub: string;
    name: string | null;
    email: string | null;
    tenantId: string | null;
  }): Promise<{ sid: string; record: SessionRecord }> {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      sub: input.sub,
      name: input.name,
      email: input.email,
      tenantId: input.tenantId,
      createdAt: now,
      lastSeenAt: now,
    };
    const sid = randomBytes(32).toString("base64url");
    await this.store.set(sid, record, this.ttlSeconds);
    return { sid, record };
  }

  async read(sid: string | null | undefined): Promise<SessionRecord | null> {
    if (!sid) return null;
    const record = await this.store.get(sid);
    if (!record) return null;
    // 滑动续期，但最多每分钟写一次：读性能不被每次请求的写拖慢。
    const lastSeen = Date.parse(record.lastSeenAt);
    if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > 60_000) {
      const next: SessionRecord = { ...record, lastSeenAt: new Date().toISOString() };
      await this.store.set(sid, next, this.ttlSeconds);
      return next;
    }
    return record;
  }

  /**
   * 换了租户就换一把 sid：旧 Cookie 立刻失效，防止「切换前后两个标签页
   * 共用一把凭据、各自以为是不同租户」。
   */
  async rebind(
    sid: string | null,
    record: SessionRecord,
    patch: { tenantId: string | null },
  ): Promise<{ sid: string; record: SessionRecord }> {
    if (sid) await this.store.delete(sid);
    return this.create({
      sub: record.sub,
      name: record.name,
      email: record.email,
      tenantId: patch.tenantId,
    });
  }

  async destroy(sid: string | null | undefined): Promise<void> {
    if (!sid) return;
    await this.store.delete(sid);
  }
}

/**
 * 生产装配：Redis；本地/dev 用进程内会话（不要求本机跑 Redis）。
 * Redis 连接失败时生产侧 fail-closed：会话读不到 = 401，绝不降级为无租户。
 */
export function createSessionService(): {
  service: SessionService;
  close: () => Promise<void>;
} {
  const env = loadEnv();
  if (env.SESSION_STORE === "memory" || (env.SESSION_STORE === "auto" && env.AUTH_MODE === "dev")) {
    // 多实例部署下进程内会话会让同一个人被不同实例随机判为未登录，
    // 所以只在本地/测试（AUTH_MODE=dev 且未显式要求 redis）允许。
    return { service: new SessionService(new MemorySessionStore()), close: async () => {} };
  }
  const handle = connectRedis(env.REDIS_URL);
  // ioredis 采用 lazyConnect；首个命令会触发连接。连不上时读取失败 = 401（fail-closed）。
  void handle.client.connect().catch(() => undefined);
  return {
    service: new SessionService(new RedisSessionStore(handle.client)),
    close: () => handle.close(),
  };
}
