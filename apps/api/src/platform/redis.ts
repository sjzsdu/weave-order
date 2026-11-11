import Redis from "ioredis";

export interface RedisHandle {
  client: Redis;
  close: () => Promise<void>;
}

/**
 * Redis 用于会话缓存、智能体后台任务队列与审批队列实时通知。
 * 连接失败不阻塞内核演示：调用方自行决定是否降级。
 */
export function connectRedis(redisUrl: string): RedisHandle {
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 2000,
  });
  // 未连接时 ioredis 会抛 error event；连接失败由 pingRedis 判定，不打扰进程。
  client.on("error", () => undefined);
  return {
    client,
    close: async () => {
      await client.quit().catch(() => client.disconnect());
    },
  };
}

export async function pingRedis(client: Redis): Promise<boolean> {
  try {
    await client.connect();
    const pong = await client.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}
