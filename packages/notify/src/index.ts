/**
 * 出站通知：把「邀请链接」「试用到期提醒」发到邮件或短信。
 *
 * 设计取舍：
 * - 不引入邮件/SMS SDK：国内短信与邮件服务商接口差异大，绑定一家就会被锁死。
 *   这里定义一条最小契约，通过 `webhook` 交给一个自建网关（或云函数）去调服务商。
 * - 默认 `log`：本地与未配置网关时不假装发送成功，返回 `ok:false`，
 *   让界面老实显示「请手动把链接发给他」。
 * - 失败不抛异常：通知失败不能回滚业务（邀请已经建好了，链接已经生成了）。
 */

export type NotifyChannel = "email" | "sms";

export interface NotifyMessage {
  channel: NotifyChannel;
  /** 邮箱或手机号。 */
  to: string;
  subject?: string;
  text: string;
}

export interface NotifyResult {
  ok: boolean;
  provider: "log" | "webhook";
  /** 失败原因或网关返回的追踪号，给运营排查用。 */
  detail?: string;
}

export interface NotifyConfig {
  provider: "log" | "webhook";
  webhookUrl?: string;
  token?: string;
  timeoutMs?: number;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface Notifier {
  send(message: NotifyMessage): Promise<NotifyResult>;
}

/** 日志里不出现完整邮箱/手机号。 */
export function maskAddress(value: string): string {
  const [name = "", domain] = value.split("@");
  if (domain) {
    const head = name.slice(0, 2);
    return `${head}***@${domain}`;
  }
  return value.length > 4 ? `${value.slice(0, 3)}****${value.slice(-2)}` : "***";
}

export function createNotifier(config: NotifyConfig): Notifier {
  const log = config.log ?? ((line: string) => console.info(line));
  const timeoutMs = config.timeoutMs ?? 5000;
  const doFetch = config.fetchImpl ?? fetch;

  if (config.provider === "log" || !config.webhookUrl) {
    return {
      send(message) {
        log(
          `[notify:log] ${message.channel} -> ${maskAddress(message.to)}｜${message.subject ?? ""}｜${message.text}`,
        );
        return Promise.resolve({
          ok: false,
          provider: "log",
          detail: "未配置发送通道（NOTIFY_WEBHOOK_URL），请手动把链接发给对方",
        });
      },
    };
  }

  const url = config.webhookUrl;
  return {
    async send(message) {
      try {
        const response = await doFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
          },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          return {
            ok: false,
            provider: "webhook",
            detail: `网关返回 ${response.status}`,
          };
        }
        return { ok: true, provider: "webhook" };
      } catch (error) {
        return {
          ok: false,
          provider: "webhook",
          detail: error instanceof Error ? error.message : "发送失败",
        };
      }
    },
  };
}

/** 邀请文案：一条链接，说清是谁邀请、几天有效。 */
export function inviteMessage(input: {
  channel: NotifyChannel;
  to: string;
  inviterName: string;
  tenantName: string;
  url: string;
  expiresAt: Date;
}): NotifyMessage {
  const day = input.expiresAt.toLocaleDateString("zh-CN");
  return {
    channel: input.channel,
    to: input.to,
    subject: `${input.inviterName} 邀请你加入「${input.tenantName}」`,
    text: [
      `${input.inviterName} 邀请你加入「${input.tenantName}」。`,
      `点开链接、登录后点「接受邀请」即可加入：${input.url}`,
      `链接 ${day} 前有效；只能用这个邮箱的账号接受。`,
    ].join("\n"),
  };
}

/** 试用到期提醒：提前 1 天发一次。 */
export function trialEndingMessage(input: {
  channel: NotifyChannel;
  to: string;
  tenantName: string;
  endsAt: Date;
}): NotifyMessage {
  return {
    channel: input.channel,
    to: input.to,
    subject: `「${input.tenantName}」试用将在明天结束`,
    text: [
      `「${input.tenantName}」的 3 天试用将在 ${input.endsAt.toLocaleString("zh-CN")} 结束。`,
      `到期后账号转只读 30 天，数据保留；要继续用，回复这条消息或写信到 hello@weaveorder.cn。`,
      `不自动扣费。`,
    ].join("\n"),
  };
}
