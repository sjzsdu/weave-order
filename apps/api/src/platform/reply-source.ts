import { RawCustomerReply } from "@weave-order/schema";
import type { RawCustomerReply as RawReply } from "@weave-order/schema";

/**
 * 客户回复信号来源。
 *
 * 渠道适配器（微信 / 企业微信 / 邮件 / 电话转写）负责把原始报文解析成
 * `RawCustomerReply`；意图识别由 LLM provider 完成，节点只做编排。
 * 以后接真实渠道时，实现本接口并替换配置即可。
 */
export interface ReplySource {
  readonly name: string;
  fetchLatest(input: { customerId: string; shipmentId: string }): Promise<RawReply | null>;
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

export function createReplySource(provider = "local-scripted"): ReplySource {
  if (provider === "local-scripted") return new LocalScriptedReplySource();
  throw new Error(
    `REPLY_SOURCE=${provider} 尚未接入；当前支持：local-scripted。真实渠道请实现 ReplySource 后在此注册。`,
  );
}
