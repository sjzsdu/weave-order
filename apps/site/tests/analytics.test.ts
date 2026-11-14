/**
 * 官网埋点的用例。
 *
 * 两件事必须被证明，否则埋点会悄悄坏掉：
 * 1. provider 未配置时完全静默——不注入第三方脚本、不发请求、不留副作用；
 * 2. 属性白名单生效——表里没有的键、含邮箱或长数字的值一律丢弃。
 *
 * 纯函数直接 require（analytics.js 是 UMD，浏览器与 Node 都能加载）；
 * 「静默 / 注入」这类要看全局副作用的部分用 vm 跑一遍真实文件。
 * `pnpm --filter @weave-order/site test` 会先 build 再跑这里。
 */
import { readFileSync } from "node:fs";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const analyticsPath = fileURLToPath(new URL("../public/assets/analytics.js", import.meta.url));
const source = readFileSync(analyticsPath, "utf8");

/**
 * 取纯函数。apps/site 是 `"type": "module"`，直接 require 这个 .js 会当 ESM 处理
 * （UMD 的 module.exports 分支不执行），所以用 vm 给它一个 CJS 的 module 对象。
 */
function loadCore() {
  const moduleRef = { exports: {} };
  const context = vm.createContext({ module: moduleRef, exports: moduleRef.exports, console });
  vm.runInContext(source, context, { filename: "analytics.js" });
  return moduleRef.exports;
}

const core = loadCore() as {
  EVENT_PROPS: Record<string, readonly string[]>;
  CTA_LOCATIONS: string[];
  sanitizeProps: (event: string, props?: Record<string, unknown>) => Record<string, string>;
  normalizeConfig: (raw: unknown) => { provider: string; host: string; enabled: boolean };
  scriptSpec: (config: unknown) => { src: string; attrs: Record<string, string> } | null;
  looksPersonal: (value: string) => boolean;
};

/** vm 里造的对象与宿主原型不同，比较前先拉平。 */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

interface FakeScript {
  src?: string;
  attrs: Record<string, string>;
  handlers?: Record<string, () => void>;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, handler: () => void): void;
}

/** 在假窗口里跑一遍 analytics.js，返回副作用（注入的 script、注册的监听）。 */
function loadSite(config: unknown, options: { dnt?: boolean } = {}) {
  const appended: FakeScript[] = [];
  const listeners: Record<string, (event: { target: unknown }) => void> = {};
  const windowRef: Record<string, unknown> = {
    WEAVE_ANALYTICS: config,
    navigator: { doNotTrack: options.dnt ? "1" : "0" },
  };
  const documentRef = {
    head: {
      appendChild(element: FakeScript) {
        appended.push(element);
      },
    },
    createElement(): FakeScript {
      return {
        attrs: {},
        setAttribute(name, value) {
          this.attrs[name] = value;
        },
        addEventListener(type, handler) {
          this.handlers = this.handlers ?? {};
          this.handlers[type] = handler;
        },
      };
    },
    addEventListener(type: string, handler: (event: { target: unknown }) => void) {
      listeners[type] = handler;
    },
  };
  const context = vm.createContext({ window: windowRef, document: documentRef, console });
  // 浏览器里 window.document 就是 document；analytics.js 从 root.document 启动。
  windowRef.document = documentRef;
  vm.runInContext(source, context, { filename: "analytics.js" });
  return {
    window: windowRef as {
      weaveAnalytics: { enabled: boolean; track: (name: string, props?: unknown) => boolean };
      plausible?: { q: unknown[][] };
    },
    appended,
    click(target: unknown) {
      listeners.click?.({ target });
    },
  };
}

function element(attrs: Record<string, string>, text = "") {
  return {
    textContent: text,
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    closest(selector: string) {
      if (selector === "[data-cta]" && attrs["data-cta"]) return this;
      if (selector === "[data-login]" && attrs["data-login"]) return this;
      return null;
    },
  };
}

describe("官网统计：静默与注入", () => {
  it("未配置 provider 时零注入、零请求", () => {
    for (const config of [undefined, {}, { provider: "none" }, { provider: "" }]) {
      const site = loadSite(config);
      expect(site.appended).toHaveLength(0);
      expect(site.window.weaveAnalytics.enabled).toBe(false);
      expect(site.window.weaveAnalytics.track("cta_click", { location: "hero" })).toBe(false);
      expect(site.window.plausible).toBeUndefined();
    }
  });

  it("构建产物里的占位符没被渲染时也不统计（本地预览的安全默认）", () => {
    const site = loadSite({
      provider: "__WEAVE_ANALYTICS_PROVIDER__",
      domain: "__WEAVE_ANALYTICS_DOMAIN__",
    });
    expect(site.window.weaveAnalytics.enabled).toBe(false);
    expect(site.appended).toHaveLength(0);
  });

  it("Do Not Track 打开时同样静默", () => {
    const site = loadSite({ provider: "plausible", domain: "weaveorder.cn" }, { dnt: true });
    expect(site.appended).toHaveLength(0);
    expect(site.window.weaveAnalytics.enabled).toBe(false);
  });

  it("Plausible 生效时注入官方脚本并带上域名", () => {
    const site = loadSite({ provider: "plausible", domain: "weaveorder.cn" });
    expect(site.appended).toHaveLength(1);
    expect(site.appended[0]?.src).toBe("https://plausible.io/js/script.js");
    expect(site.appended[0]?.attrs["data-domain"]).toBe("weaveorder.cn");
    expect(site.window.weaveAnalytics.enabled).toBe(true);
  });

  it("自建地址去掉结尾斜杠；PostHog 缺 key 时不发请求", () => {
    const selfHosted = loadSite({
      provider: "plausible",
      domain: "weaveorder.cn",
      host: "https://stats.weaveorder.cn/",
    });
    expect(selfHosted.appended[0]?.src).toBe("https://stats.weaveorder.cn/js/script.js");

    expect(loadSite({ provider: "posthog", host: "https://ph.internal" }).appended).toHaveLength(0);
  });

  it("非本地主机只接受 https 的统计脚本地址", () => {
    expect(
      core.normalizeConfig({ provider: "plausible", domain: "a.com", host: "http://stats.a.com" })
        .enabled,
    ).toBe(false);
    expect(
      core.normalizeConfig({
        provider: "plausible",
        domain: "a.com",
        host: "http://localhost:8000",
      }).enabled,
    ).toBe(true);
    expect(
      core.normalizeConfig({ provider: "plausible", domain: "a.com", host: "stats.a.com" }).enabled,
    ).toBe(false);
  });
});

describe("官网统计：属性白名单", () => {
  it("cta_click 只留 location / label / target，邮箱与手机号被丢弃", () => {
    expect(
      core.sanitizeProps("cta_click", {
        location: "hero",
        label: "免费试用 3 天",
        target: "signup.html",
        email: "boss@qinghe.com",
        phone: "13800001111",
        customer: "青禾纺织",
      }),
    ).toEqual({ location: "hero", label: "免费试用 3 天", target: "signup.html" });
  });

  it("值含邮箱或长数字时整条丢弃", () => {
    expect(core.looksPersonal("boss@qinghe.com")).toBe(true);
    expect(core.looksPersonal("138 0013 8000")).toBe(true);
    expect(core.looksPersonal("signup.html?plan=pro")).toBe(false);
    expect(
      core.sanitizeProps("cta_click", { location: "hero", target: "tel:13800001111" }),
    ).toEqual({
      location: "hero",
    });
  });

  it("枚举属性收敛成 other", () => {
    expect(core.sanitizeProps("cta_click", { location: "popup" })).toEqual({ location: "other" });
    expect(core.sanitizeProps("login_click", { from: "site-nav" })).toEqual({ from: "site-nav" });
    expect(core.sanitizeProps("login_click", { from: "wechat" })).toEqual({ from: "other" });
  });

  it("字典外的事件不产出属性", () => {
    expect(core.sanitizeProps("purchase", { amount: 299 })).toEqual({});
    expect(core.sanitizeProps("invite_created", { role: "SALES", email: "a@b.com" })).toEqual({
      role: "SALES",
    });
  });
});

describe("官网统计：点击委托", () => {
  it("data-cta 与 data-login 各自上报一次", () => {
    const site = loadSite({ provider: "plausible", domain: "weaveorder.cn" });
    site.click(element({ "data-cta": "hero", href: "signup.html" }, "免费试用 3 天"));
    site.click(element({ "data-login": "site-nav", href: "/login.html" }, "登录"));

    const queue = site.window.plausible?.q ?? [];
    expect(queue).toHaveLength(2);
    expect(plain(Array.from(queue[0]))).toEqual([
      "cta_click",
      { props: { location: "hero", label: "免费试用 3 天", target: "signup.html" } },
    ]);
    expect(plain(Array.from(queue[1]))).toEqual(["login_click", { props: { from: "site-nav" } }]);
  });

  it("mailto 地址不会出站", () => {
    const site = loadSite({ provider: "plausible", domain: "weaveorder.cn" });
    site.click(element({ "data-cta": "footer", href: "mailto:hello@weaveorder.cn" }, "写信给我们"));
    const entry = Array.from(site.window.plausible?.q?.[0] ?? []);
    expect(plain(entry[1])).toEqual({
      props: { location: "footer", label: "写信给我们" },
    });
  });
});

describe("官网构建产物里的埋点", () => {
  it("每个页面都引了统计脚本与配置占位符", () => {
    const distDir = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
    const pages = [
      "index.html",
      "pricing.html",
      "signup.html",
      "download.html",
      "login.html",
      "docs/index.html",
    ];
    for (const page of pages) {
      const html = readFileSync(resolve(distDir, page), "utf8");
      expect(html, `${page} 缺 WEAVE_ANALYTICS 配置`).toContain("window.WEAVE_ANALYTICS=");
      expect(html, `${page} 缺 analytics.js`).toContain('src="/assets/analytics.js"');
    }
  });

  it("关键 CTA 都带 data-cta，登录入口带 data-login", () => {
    const distDir = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
    const index = readFileSync(resolve(distDir, "index.html"), "utf8");
    expect(index).toContain('data-cta="hero"');
    expect(index).toContain('data-cta="pricing-card"');
    expect(index).toContain('data-cta="nav"');
    expect(index).toContain('data-login="site-nav"');

    const pricing = readFileSync(resolve(distDir, "pricing.html"), "utf8");
    expect(pricing).toContain('data-cta="pricing-cta"');

    const download = readFileSync(resolve(distDir, "download.html"), "utf8");
    expect(download).toContain('data-cta="download"');
  });
});
