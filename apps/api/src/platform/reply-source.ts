import { RawCustomerReply } from "@weave-order/schema";
import type { RawCustomerReply as RawReply } from "@weave-order/schema";

/**
 * 客户回复信号来源。
 *
 * 渠道适配器负责把原始报文解析成 `RawCustomerReply`；意图识别由 LLM provider 完成，
 * 节点只做编排。2026-11-14 拍板后，生产路径只有「手工录入」一个来源：
 * `ManualReplySource` 从 `inbound_messages` 取一条未被消费的回复。
 */
export interface ReplySource {
  readonly name: string;
  fetchLatest(input: { customerId: string; shipmentId: string }): Promise<RawReply | null>;
}

/** 取一条未消费的手工回复；实现方负责把它标记为 consumed，保证只驱动一次。 */
export type FetchManualReply = (input: { customerId: string; shipmentId: string }) => Promise<{
  id: string;
  text: string;
  receivedAt: string;
} | null>;

/**
 * 手工录入来源（粘贴文本 / 截图 OCR）。
 *
 * 契约映射（评审 D4）：`RawCustomerReply.channel` 是「触达渠道」，而
 * `inbound_messages.channel` 是「录入方式」（manual / screenshot），两者不是一回事。
 * 业务上这些回复都来自客户微信，所以统一映射为 WECHAT，录入方式不向下游泄漏。
 */
export class ManualReplySource implements ReplySource {
  readonly name = "manual-v1";

  constructor(private readonly fetch: FetchManualReply) {}

  async fetchLatest(input: { customerId: string; shipmentId: string }): Promise<RawReply | null> {
    const row = await this.fetch(input);
    if (!row) return null;
    return RawCustomerReply.parse({
      id: row.id,
      channel: "WECHAT",
      text: row.text,
      receivedAt: row.receivedAt,
    });
  }
}

/**
 * 本地脚本化来源：按顺序吐预设回复，用完后返回 null（表示「还没回」）。
 * 演示用 `new LocalScriptedReplySource()` 表示客户尚未回复，由 resume 注入回复。
 */
export class LocalScriptedReplySource implements ReplySource {
  readonly name = "local-scripted-v1";
  private readonly queue: RawReply[];

  constructor(replies: RawReply[] = []) {
    this.queue = replies.map((reply) => RawCustomerReply.parse(reply));
  }

  fetchLatest(_input: { customerId: string; shipmentId: string }): Promise<RawReply | null> {
    return Promise.resolve(this.queue.shift() ?? null);
  }
}

export function createReplySource(
  provider = "local-scripted",
  deps: { fetchManualReply?: FetchManualReply } = {},
): ReplySource {
  if (provider === "local-scripted") return new LocalScriptedReplySource();
  if (provider === "manual") {
    if (!deps.fetchManualReply) {
      throw new Error("REPLY_SOURCE=manual 需要绑定 inbound_messages 取数（fetchManualReply）");
    }
    return new ManualReplySource(deps.fetchManualReply);
  }
  throw new Error(
    `REPLY_SOURCE=${provider} 尚未接入；当前支持：local-scripted / manual。真实渠道请实现 ReplySource 后在此注册。`,
  );
}
