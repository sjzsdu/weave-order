/**
 * 官网统计的用例（node --test site/tools）。
 *
 * 两件事必须被证明，否则埋点会悄悄坏掉：
 * 1. provider 未配置时完全静默——不注入第三方脚本、不发请求、不留副作用；
 * 2. 属性白名单生效——表里没有的键、含邮箱或长数字的值一律丢弃。
 *
 * 纯函数直接 require；「静默 / 注入」这类要看全局副作用的部分用 vm 跑一遍
 * 真实的 assets/analytics.js。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const core = require("../assets/analytics.js");
const source = readFileSync(new URL("../assets/analytics.js", import.meta.url), "utf8");

/** 在假窗口里跑一遍 analytics.js，返回副作用（注入的 script、注册的监听）。 */
function loadSite(config, options = {}) {
  const appended = [];
  const listeners = {};
  const windowRef = {
    WEAVE_ANALYTICS: config,
    navigator: { doNotTrack: options.dnt ? "1" : "0" },
  };
  const documentRef = {
    head: {
      appendChild(element) {
        appended.push(element);
      },
    },
    createElement() {
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
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
  };
  const context = vm.createContext({ window: windowRef, document: documentRef, console });
  vm.runInContext(source, context, { filename: "site/assets/analytics.js" });
  return {
    window: windowRef,
    appended,
    listeners,
    click(target) {
      assert.ok(listeners.click, "点击监听应已注册");
      listeners.click({ target });
    },
  };
}

/** vm 里造的对象原型与宿主不同，比较前先拉平成本地对象。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function element(attrs, text = "") {
  return {
    textContent: text,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    closest(selector) {
      if (selector === "[data-cta]" && attrs["data-cta"]) return this;
      if (selector === "[data-login]" && attrs["data-login"]) return this;
      return null;
    },
  };
}

test("未配置 provider：完全静默，不注入脚本", () => {
  for (const config of [undefined, {}, { provider: "none" }, { provider: "" }]) {
    const site = loadSite(config);
    assert.equal(site.appended.length, 0, "不该注入任何第三方脚本");
    assert.equal(site.window.weaveAnalytics.enabled, false);
    assert.equal(site.window.weaveAnalytics.track("cta_click", { location: "hero" }), false);
    assert.equal(site.window.plausible, undefined, "不该留下全局变量");
  }
});

test("Do Not Track 打开时同样静默", () => {
  const site = loadSite({ provider: "plausible", domain: "weaveorder.cn" }, { dnt: true });
  assert.equal(site.appended.length, 0);
  assert.equal(site.window.weaveAnalytics.enabled, false);
});

test("Plausible 配置生效：注入官方脚本并带上域名", () => {
  const site = loadSite({ provider: "plausible", domain: "weaveorder.cn" });
  assert.equal(site.appended.length, 1);
  const script = site.appended[0];
  assert.equal(script.src, "https://plausible.io/js/script.js");
  assert.equal(script.attrs["data-domain"], "weaveorder.cn");
  assert.equal(site.window.weaveAnalytics.enabled, true);
});

test("自建 host 与 PostHog 缺 key 的降级", () => {
  const selfHosted = loadSite({
    provider: "plausible",
    domain: "weaveorder.cn",
    host: "https://stats.weaveorder.cn/",
  });
  assert.equal(selfHosted.appended[0].src, "https://stats.weaveorder.cn/js/script.js");

  const noKey = loadSite({ provider: "posthog", host: "https://ph.internal" });
  assert.equal(noKey.appended.length, 0, "PostHog 没有 project key 时不该发请求");
});

test("host 写了但不是 http(s) 地址：不启用，也不回退到默认站点", () => {
  const site = loadSite({ provider: "plausible", domain: "weaveorder.cn", host: "stats.a.com" });
  assert.equal(site.appended.length, 0);
  assert.equal(site.window.weaveAnalytics.enabled, false);
});

test("cta_click 属性白名单：未知键与邮箱被丢弃", () => {
  const props = core.sanitizeProps("cta_click", {
    location: "hero",
    label: "免费试用 3 天",
    target: "signup.html",
    email: "boss@qinghe.com",
    phone: "13800001111",
    customer: "青禾纺织",
  });
  assert.deepEqual(props, {
    location: "hero",
    label: "免费试用 3 天",
    target: "signup.html",
  });
});

test("属性值含邮箱或长数字时整条丢弃", () => {
  assert.equal(core.looksPersonal("boss@qinghe.com"), true);
  assert.equal(core.looksPersonal("138 0013 8000"), true);
  assert.equal(core.looksPersonal("signup.html?plan=pro"), false);

  const props = core.sanitizeProps("cta_click", {
    location: "hero",
    label: "联系 boss@qinghe.com",
    target: "tel:13800001111",
  });
  assert.deepEqual(props, { location: "hero" }, "两个值都应被丢弃，只留 location");
});

test("枚举属性收敛：未知 location / from 归为 other", () => {
  assert.deepEqual(core.sanitizeProps("cta_click", { location: "somewhere" }), {
    location: "other",
  });
  assert.deepEqual(core.sanitizeProps("login_click", { from: "site-nav" }), { from: "site-nav" });
  assert.deepEqual(core.sanitizeProps("login_click", { from: "wechat" }), { from: "other" });
});

test("只有字典里的事件有属性，其它事件一个字段也不留", () => {
  assert.deepEqual(core.sanitizeProps("signup_form_submit", { email: "a@b.com" }), {});
  assert.deepEqual(core.sanitizeProps("invite_created", { role: "SALES", email: "a@b.com" }), {
    role: "SALES",
  });
  assert.deepEqual(core.sanitizeProps("not_an_event", { role: "SALES" }), {});
});

test("点击委托：data-cta 与 data-login 各自上报一次", () => {
  const site = loadSite({ provider: "plausible", domain: "weaveorder.cn" });
  site.click(
    element({ "data-cta": "hero", href: "signup.html" }, "免费试用 3 天"),
  );
  site.click(element({ "data-login": "site-nav", href: "login.html" }, "登录"));

  const queue = site.window.plausible.q;
  assert.equal(queue.length, 2);

  const [ctaName, ctaOptions] = plain(Array.from(queue[0]));
  assert.equal(ctaName, "cta_click");
  assert.deepEqual(ctaOptions.props, {
    location: "hero",
    label: "免费试用 3 天",
    target: "signup.html",
  });

  const [loginName, loginOptions] = plain(Array.from(queue[1]));
  assert.equal(loginName, "login_click");
  assert.deepEqual(loginOptions.props, { from: "site-nav" });
});

test("点击元素上的邮箱文案不会出站", () => {
  const site = loadSite({ provider: "plausible", domain: "weaveorder.cn" });
  site.click(element({ "data-cta": "footer", href: "mailto:hello@weaveorder.cn" }, "写信给我们"));
  const [, options] = plain(Array.from(site.window.plausible.q[0]));
  assert.deepEqual(options.props, { location: "footer", label: "写信给我们" }, "mailto 地址被丢弃");
});

test("PostHog 配置：按 cookieless 参数初始化并统一发 pageview", () => {
  const site = loadSite({
    provider: "posthog",
    host: "https://ph.weaveorder.cn",
    key: "phc_abcdefgh12345678",
  });
  assert.equal(site.appended.length, 1);
  const script = site.appended[0];
  assert.equal(script.src, "https://ph.weaveorder.cn/static/array.js");

  const captured = [];
  site.window.posthog = {
    init(key, options) {
      this.initKey = key;
      this.options = options;
    },
    capture(name, props) {
      captured.push([name, props]);
    },
  };
  script.handlers.load();

  assert.equal(site.window.posthog.initKey, "phc_abcdefgh12345678");
  assert.equal(site.window.posthog.options.persistence, "memory");
  assert.equal(site.window.posthog.options.capture_pageview, false);
  assert.equal(site.window.posthog.options.disable_session_recording, true);
  assert.deepEqual(plain(captured), [["pageview", {}]]);
});
