import { TrackingSnapshot } from "@weave-order/schema";

/**
 * 物流 provider 接口。
 *
 * 默认实现是确定性的本地模拟：用运单号哈希决定状态与事件，不访问外部 API。
 * 以后接顺丰/快递100 等，只需实现 track()，图与工具都不用改。
 */
export interface LogisticsProvider {
  readonly name: string;
  track(input: { carrier: string; trackingNumber: string }): Promise<TrackingSnapshot>;
}

const HOUR_MS = 60 * 60 * 1000;

const STATUSES = ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"] as const;

function hashOf(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + (value.charCodeAt(i) ?? 0)) >>> 0;
  }
  return hash;
}

/** 本地确定性实现：同一运单号永远返回同一状态序列。 */
export class LocalDeterministicLogisticsProvider implements LogisticsProvider {
  readonly name = "local-deterministic-v1";

  constructor(private readonly now: () => Date = () => new Date()) {}

  async track(input: { carrier: string; trackingNumber: string }): Promise<TrackingSnapshot> {
    const hash = hashOf(`${input.carrier}:${input.trackingNumber}`);
    const status = STATUSES[hash % STATUSES.length] ?? "IN_TRANSIT";
    const now = this.now().getTime();
    const events = [
      {
        at: new Date(now - 48 * HOUR_MS).toISOString(),
        description: "已揽收",
        location: "杭州转运中心",
      },
      {
        at: new Date(now - 24 * HOUR_MS).toISOString(),
        description: "运输中",
        location: "上海分拨中心",
      },
    ];
    if (status === "OUT_FOR_DELIVERY" || status === "DELIVERED") {
      events.push({
        at: new Date(now - 3 * HOUR_MS).toISOString(),
        description: "派送中",
        location: "客户所在城市",
      });
    }
    if (status === "DELIVERED") {
      events.push({
        at: new Date(now - 2 * HOUR_MS).toISOString(),
        description: "已签收",
        location: "客户仓库",
      });
    }

    return Promise.resolve(
      TrackingSnapshot.parse({
        carrier: input.carrier,
        trackingNumber: input.trackingNumber,
        status,
        events,
        provider: this.name,
      }),
    );
  }
}

export function createLogisticsProvider(provider = "local-deterministic"): LogisticsProvider {
  if (provider === "local-deterministic") {
    return new LocalDeterministicLogisticsProvider();
  }
  throw new Error(
    `LOGISTICS_PROVIDER=${provider} 尚未接入；当前支持：local-deterministic。真实物流请实现 LogisticsProvider 后在此注册。`,
  );
}
