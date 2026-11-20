import { describe, expect, it } from "vitest";
import {
  analyticsConfig,
  applyAnalyticsConfig,
  EVENT_PROPS,
  looksPersonal,
  resolveConfig,
  sanitizeProps,
} from "./analytics";

describe("工作台埋点配置", () => {
  it("没配 provider 时关闭，不产生任何上报", () => {
    for (const raw of [undefined, null, {}, { provider: "none" }, { provider: "随便写的" }]) {
      const config = resolveConfig(raw);
      expect(config.enabled).toBe(false);
      expect(config.provider).toBe("none");
    }
  });

  it("Plausible 需要域名，缺域名就不启用", () => {
    expect(resolveConfig({ provider: "plausible" }).enabled).toBe(false);
    const config = resolveConfig({ provider: "plausible", domain: "weave.wnbgj.com" });
    expect(config).toMatchObject({
      provider: "plausible",
      domain: "weave.wnbgj.com",
      host: "https://plausible.io",
      enabled: true,
    });
  });

  it("自建 Plausible 地址去掉结尾斜杠", () => {
    const config = resolveConfig({
      provider: "plausible",
      domain: "weave.wnbgj.com",
      host: "https://stats.weaveorder.cn/",
    });
    expect(config.host).toBe("https://stats.weaveorder.cn");
  });

  it("PostHog 需要 project key", () => {
    expect(resolveConfig({ provider: "posthog" }).enabled).toBe(false);
    expect(resolveConfig({ provider: "posthog", key: "phc_x" })).toMatchObject({
      host: "https://us.i.posthog.com",
      enabled: true,
    });
  });

  it("host 不是 http(s) 地址时降级为不启用", () => {
    expect(
      resolveConfig({ provider: "plausible", domain: "a.com", host: "stats.a.com" }).enabled,
    ).toBe(false);
  });

  it("非本地主机只接受 https 的统计脚本地址", () => {
    expect(
      resolveConfig({ provider: "plausible", domain: "a.com", host: "http://stats.a.com" }).enabled,
    ).toBe(false);
    expect(
      resolveConfig({ provider: "plausible", domain: "a.com", host: "http://localhost:8000" })
        .enabled,
    ).toBe(true);
  });

  it("部署期配置到达前（或为空）不上报", () => {
    expect(applyAnalyticsConfig(undefined).enabled).toBe(false);
    expect(analyticsConfig()?.enabled).toBe(false);
    expect(applyAnalyticsConfig({ provider: "", domain: "", host: "", key: "" }).enabled).toBe(
      false,
    );
  });
});

describe("属性白名单", () => {
  it("事件字典固定，新增事件要同步官网实现与 README", () => {
    expect(Object.keys(EVENT_PROPS).sort()).toEqual(
      [
        "activate_completed",
        "activate_link_opened",
        "cta_click",
        "invite_accepted",
        "invite_created",
        "item_opened",
        "items_viewed",
        "login_click",
        "pageview",
        "signup_form_submit",
        "workspace_nav_clicked",
      ].sort(),
    );
  });

  it("cta_click 只留 location / label / target，邮箱与手机号被丢弃", () => {
    expect(
      sanitizeProps("cta_click", {
        location: "hero",
        label: "免费试用",
        target: "signup.html",
        email: "boss@qinghe.com",
        phone: "13800001111",
        customer: "青禾纺织",
      }),
    ).toEqual({ location: "hero", label: "免费试用", target: "signup.html" });
  });

  it("值里带邮箱或长数字时整条属性丢弃", () => {
    expect(looksPersonal("boss@qinghe.com")).toBe(true);
    expect(looksPersonal("138 0013 8000")).toBe(true);
    expect(looksPersonal("/activate?code=abc")).toBe(false);
    expect(sanitizeProps("cta_click", { location: "nav", label: "找 13800001111" })).toEqual({
      location: "nav",
    });
  });

  it("枚举属性收敛成 other", () => {
    expect(sanitizeProps("cta_click", { location: "popup" })).toEqual({ location: "other" });
    expect(sanitizeProps("login_click", { from: "login-page" })).toEqual({ from: "login-page" });
    expect(sanitizeProps("login_click", { from: "wechat" })).toEqual({ from: "other" });
  });

  it("邀请类事件只记角色", () => {
    expect(
      sanitizeProps("invite_created", { role: "SALES", email: "colleague@qinghe.com" }),
    ).toEqual({ role: "SALES" });
    expect(sanitizeProps("invite_accepted", { role: "FINANCE" })).toEqual({ role: "FINANCE" });
  });

  it("没有属性的转化事件不接受任何字段", () => {
    expect(sanitizeProps("signup_form_submit", { email: "a@b.com", plan: "pro" })).toEqual({});
    expect(sanitizeProps("activate_completed", { tenant: "青禾纺织" })).toEqual({});
  });

  it("字典外的事件不产出属性", () => {
    expect(sanitizeProps("purchase", { amount: 299 })).toEqual({});
  });
});
