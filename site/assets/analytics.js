/* 织序 WeaveOrder · 官网访问统计
 *
 * 事件字典、属性白名单与「怎么加新事件」见 site/README.md「访问统计」。
 * 三条硬约束，改代码时不要放松：
 * 1. 配置为空或 provider=none 时完全静默：不注入第三方脚本、不发请求、不写 cookie。
 * 2. 属性走白名单（EVENT_PROPS）：表里没有的键一律丢弃；含邮箱或长串数字的值也丢弃。
 * 3. 只上报匿名事件本身，不做跨站追踪、不读 document.cookie。
 *
 * 浏览器里由 <script src="assets/analytics.js" defer> 加载；同一个文件也被
 * site/tools/analytics.test.mjs 用 require()/vm 引入做纯函数与「静默模式」测试，
 * 所以外面包了一层 UMD。Next 应用有一份等价实现（apps/web/src/analytics.ts），
 * 改事件表时两处一起改。
 */

(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.weaveAnalyticsCore = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  /* 事件 → 允许上报的属性。这里是唯一的字典，新增事件只改这一处。 */
  var EVENT_PROPS = {
    pageview: [],
    cta_click: ["location", "label", "target"],
    signup_form_submit: [],
    login_click: ["from"],
    activate_link_opened: [],
    activate_completed: [],
    invite_created: ["role"],
    invite_accepted: ["role"],
  };

  /* 枚举型属性：不在表里的值收敛成 other，后台分组不会碎成一堆长尾。 */
  var CTA_LOCATIONS = [
    "nav",
    "hero",
    "pricing-card",
    "pricing-cta",
    "footer",
    "docs",
    "download",
  ];
  var LOGIN_FROM = ["site-nav", "site-hero", "site-footer", "login-page", "activate-page", "docs"];

  var DEFAULT_HOST = {
    plausible: "https://plausible.io",
    posthog: "https://us.i.posthog.com",
  };

  var MAX_VALUE_LENGTH = 120;

  function asText(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number" && isFinite(value)) return String(value);
    return "";
  }

  /* 邮箱、手机号、订单号这类长数字一律不出站：宁可少一条属性，也不带客户联系方式。 */
  function looksPersonal(value) {
    if (value.indexOf("@") !== -1) return true;
    return /\d{7,}/.test(value.replace(/[\s\-()+.]/g, ""));
  }

  function cleanValue(value) {
    var out = asText(value).replace(/\s+/g, " ").trim();
    if (!out || out.length > MAX_VALUE_LENGTH) return "";
    if (looksPersonal(out)) return "";
    return out;
  }

  function sanitizeProps(name, props) {
    var allowed = EVENT_PROPS[name];
    if (!allowed || !props || typeof props !== "object") return {};
    var out = {};
    for (var i = 0; i < allowed.length; i += 1) {
      var key = allowed[i];
      var value = cleanValue(props[key]);
      if (!value) continue;
      if (key === "location" && CTA_LOCATIONS.indexOf(value) === -1) value = "other";
      if (key === "from" && LOGIN_FROM.indexOf(value) === -1) value = "other";
      out[key] = value;
    }
    return out;
  }

  function isEventName(name) {
    return Object.prototype.hasOwnProperty.call(EVENT_PROPS, name);
  }

  function urlBase(value) {
    var out = asText(value).trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+$/.test(out)) return "";
    return out;
  }

  /* 配置可能来自 window.WEAVE_ANALYTICS，也可能是部署时注入的空对象。 */
  function normalizeConfig(raw) {
    var input = raw && typeof raw === "object" ? raw : {};
    var provider = asText(input.provider).trim().toLowerCase();
    if (provider !== "plausible" && provider !== "posthog") provider = "none";
    var domain = asText(input.domain)
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    /* 显式写了 host 但格式不对时降级为不启用：宁可少统计，也不悄悄把数据发到默认站点。 */
    var hostInput = asText(input.host).trim();
    var host = urlBase(hostInput);
    if (!host && !hostInput && provider !== "none") host = DEFAULT_HOST[provider];
    var key = asText(input.key).trim();
    var enabled = provider === "plausible" ? Boolean(domain) && Boolean(host) : false;
    if (provider === "posthog") enabled = Boolean(key) && Boolean(host);
    return { provider: provider, domain: domain, host: host, key: key, enabled: enabled };
  }

  function scriptSpec(config) {
    if (!config || !config.enabled) return null;
    if (config.provider === "plausible") {
      return { src: config.host + "/js/script.js", attrs: { "data-domain": config.domain } };
    }
    return { src: config.host + "/static/array.js", attrs: {} };
  }

  function doNotTrack(windowRef) {
    var nav = (windowRef && windowRef.navigator) || {};
    return (
      nav.doNotTrack === "1" ||
      (windowRef && windowRef.doNotTrack === "1") ||
      nav.globalPrivacyControl === true
    );
  }

  function elementLabel(el) {
    var explicit = el.getAttribute("data-cta-label");
    if (explicit) return explicit;
    var text = el.getAttribute("aria-label") || el.textContent || "";
    return text.replace(/\s+/g, " ").trim();
  }

  function readCtaTarget(el) {
    return el.getAttribute("data-cta-target") || el.getAttribute("href") || "";
  }

  function bootstrap(windowRef, documentRef) {
    var config = normalizeConfig(windowRef.WEAVE_ANALYTICS);
    var disabled = { track: function () { return false; }, config: config, enabled: false };

    if (!config.enabled || doNotTrack(windowRef)) {
      windowRef.weaveAnalytics = disabled;
      return disabled;
    }

    var queue = [];

    if (config.provider === "plausible") {
      /* 官方队列桩：脚本还没下载完就产生的点击先排队，由它加载后自己发出去。 */
      windowRef.plausible =
        windowRef.plausible ||
        function () {
          (windowRef.plausible.q = windowRef.plausible.q || []).push(arguments);
        };
    }

    function deliver(name, props) {
      if (config.provider === "plausible") {
        windowRef.plausible(name, { props: props });
        return;
      }
      if (windowRef.posthog && typeof windowRef.posthog.capture === "function") {
        windowRef.posthog.capture(name, props);
        return;
      }
      queue.push([name, props]);
    }

    function flush() {
      while (queue.length > 0) {
        var item = queue.shift();
        deliver(item[0], item[1]);
      }
    }

    function track(name, props) {
      if (!isEventName(name)) return false;
      deliver(name, sanitizeProps(name, props));
      return true;
    }

    var spec = scriptSpec(config);
    var script = documentRef.createElement("script");
    script.defer = true;
    script.async = config.provider === "posthog";
    script.src = spec.src;
    for (var attr in spec.attrs) {
      if (Object.prototype.hasOwnProperty.call(spec.attrs, attr)) {
        script.setAttribute(attr, spec.attrs[attr]);
      }
    }

    if (config.provider === "posthog") {
      script.addEventListener("load", function () {
        if (!windowRef.posthog || typeof windowRef.posthog.init !== "function") return;
        windowRef.posthog.init(config.key, {
          api_host: config.host,
          /* 页码事件由这里统一发：两个 provider 的事件名才一致（都是 pageview）。 */
          capture_pageview: false,
          autocapture: false,
          disable_session_recording: true,
          /* 只放内存：不写 cookie 也不写 localStorage，关掉标签页即失忆。 */
          persistence: "memory",
          person_profiles: "never",
        });
        track("pageview");
        flush();
      });
    }

    documentRef.head.appendChild(script);
    /* Plausible 自己会发首屏 pageview，这里不再补发，否则会重复计数。 */

    documentRef.addEventListener(
      "click",
      function (event) {
        var target = event && event.target;
        if (!target || typeof target.closest !== "function") return;
        var cta = target.closest("[data-cta]");
        if (cta) {
          track("cta_click", {
            location: cta.getAttribute("data-cta"),
            label: elementLabel(cta),
            target: readCtaTarget(cta),
          });
        }
        var login = target.closest("[data-login]");
        if (login) track("login_click", { from: login.getAttribute("data-login") });
      },
      { capture: true },
    );

    var api = { track: track, config: config, enabled: true };
    windowRef.weaveAnalytics = api;
    return api;
  }

  return {
    EVENT_PROPS: EVENT_PROPS,
    CTA_LOCATIONS: CTA_LOCATIONS,
    LOGIN_FROM: LOGIN_FROM,
    sanitizeProps: sanitizeProps,
    normalizeConfig: normalizeConfig,
    scriptSpec: scriptSpec,
    looksPersonal: looksPersonal,
    bootstrap: bootstrap,
  };
});

(function (root) {
  "use strict";
  if (!root || typeof document === "undefined" || !root.weaveAnalyticsCore) return;
  root.weaveAnalyticsCore.bootstrap(root, document);
})(typeof window !== "undefined" ? window : null);
