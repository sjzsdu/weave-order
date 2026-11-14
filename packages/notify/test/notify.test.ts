import { describe, expect, it, vi } from "vitest";
import { createNotifier, inviteMessage, maskAddress, trialEndingMessage } from "../src";

describe("出站通知", () => {
  it("未配置网关时如实返回未发送，并遮住收件地址", async () => {
    const lines: string[] = [];
    const notifier = createNotifier({ provider: "log", log: (line) => lines.push(line) });
    const result = await notifier.send({
      channel: "email",
      to: "boss@qinghe.example",
      subject: "邀请",
      text: "链接 https://weave.wnbgj.com/join?code=x",
    });
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("log");
    expect(lines[0]).toContain("bo***@qinghe.example");
    expect(lines[0]).not.toContain("boss@qinghe.example");
  });

  it("webhook 网关成功时返回 ok", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    const notifier = createNotifier({
      provider: "webhook",
      webhookUrl: "https://notify.example/send",
      token: "t",
      fetchImpl,
    });
    const result = await notifier.send({ channel: "sms", to: "13800000000", text: "hi" });
    expect(result).toEqual({ ok: true, provider: "webhook" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const init = fetchImpl.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer t");
  });

  it("网关 5xx 与网络异常都不抛，返回失败原因", async () => {
    const failing = createNotifier({
      provider: "webhook",
      webhookUrl: "https://notify.example/send",
      fetchImpl: () => Promise.resolve(new Response("", { status: 503 })),
    });
    expect((await failing.send({ channel: "email", to: "a@b.c", text: "x" })).detail).toContain(
      "503",
    );

    const throwing = createNotifier({
      provider: "webhook",
      webhookUrl: "https://notify.example/send",
      fetchImpl: () => Promise.reject(new Error("connect timeout")),
    });
    const result = await throwing.send({ channel: "email", to: "a@b.c", text: "x" });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("connect timeout");
  });

  it("邀请与到期提醒文案包含关键信息", () => {
    const invite = inviteMessage({
      channel: "email",
      to: "emp@example.com",
      inviterName: "李老板",
      tenantName: "青禾纺织",
      url: "https://weave.wnbgj.com/join?code=abc",
      expiresAt: new Date("2026-12-01T00:00:00Z"),
    });
    expect(invite.subject).toContain("李老板");
    expect(invite.subject).toContain("青禾纺织");
    expect(invite.text).toContain("/join?code=abc");

    const reminder = trialEndingMessage({
      channel: "email",
      to: "boss@example.com",
      tenantName: "青禾纺织",
      endsAt: new Date("2026-12-01T00:00:00Z"),
    });
    expect(reminder.text).toContain("不自动扣费");
  });

  it("手机号遮罩不泄露中间位", () => {
    expect(maskAddress("13800001234")).toBe("138****34");
  });
});
