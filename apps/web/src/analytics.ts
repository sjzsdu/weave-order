"use client";

/**
 * 工作台埋点（Plausible / PostHog，cookieless）。
 *
 * 与官网的 apps/site/public/assets/analytics.js 是同一份事件字典，改事件表时
 * 两处一起改，事件表与「加新事件」的步骤写在 apps/site/README.md「访问统计」。
 *
 * 配置来自 `/config.js`（服务端按容器环境变量 ANALYTICS_* 生成）而不是
 * NEXT_PUBLIC_*：后者会被内联进客户端包，等于把统计域名钉死在镜像里。
 *
 * 三条硬约束：
 * 1. 未配置 ANALYTICS_PROVIDER（或 provider=none）时完全静默：不注入脚本、不发请求。
 * 2. 属性走白名单：表里没有的键、含邮箱或长串数字的值一律丢弃。
 * 3. 不写 cookie、不做跨站追踪；PostHog 用 memory persistence，关页即失忆。
 */

export type AnalyticsProvider = "plausible" | "posthog" | "none";

/** 事件 → 允许上报的属性。与官网 analytics.js 的 EVENT_PROPS 必须一致。 */
export const EVENT_PROPS = {
  pageview: [],
  cta_click: ["location", "label", "target"],
  signup_form_submit: [],
  login_click: ["from"],
  activate_link_opened: [],
  activate_completed: [],
  invite_created: ["role"],
  invite_accepted: ["role"],
} as const satisfies Record<string, readonly string[]>;

export type AnalyticsEvent = keyof typeof EVENT_PROPS;

const CTA_LOCATIONS = new Set([
  "nav",
  "hero",
  "pricing-card",
  "pricing-cta",
  "footer",
  "docs",
  "download",
]);

const LOGIN_FROM = new Set([
  "site-nav",
  "site-hero",
  "site-footer",
  "login-page",
  "activate-page",
  "docs",
]);

const DEFAULT_HOST: Record<"plausible" | "posthog", string> = {
  plausible: "https://plausible.io",
  posthog: "https://us.i.posthog.com",
};

const MAX_VALUE_LENGTH = 120;
/* 脚本被广告拦截时不会触发 load，队列不能无限长。 */
const MAX_QUEUE = 50;

export interface RawAnalyticsConfig {
  provider?: string;
  domain?: string;
  host?: string;
  key?: string;
}

export interface AnalyticsConfig {
  provider: AnalyticsProvider;
  domain: string;
  host: string;
  key: string;
  enabled: boolean;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** 邮箱、手机号这类值一律不出站。 */
export function looksPersonal(value: string): boolean {
  if (value.includes("@")) return true;
  return /\d{7,}/.test(value.replace(/[\s\-()+.]/g, ""));
}

function cleanValue(value: unknown): string {
  const out = asText(value).replace(/\s+/g, " ").trim();
  if (!out || out.length > MAX_VALUE_LENGTH) return "";
  if (looksPersonal(out)) return "";
  return out;
}

export function sanitizeProps(
  event: string,
  props?: Record<string, unknown>,
): Record<string, string> {
  const allowed = EVENT_PROPS[event as AnalyticsEvent];
  if (!allowed || !props) return {};
  const out: Record<string, string> = {};
  for (const key of allowed) {
    let value = cleanValue(props[key]);
    if (!value) continue;
    // 枚举属性收敛成 other，后台按 location / from 分组时不会碎成一堆长尾。
    if (key === "location" && !CTA_LOCATIONS.has(value)) value = "other";
    if (key === "from" && !LOGIN_FROM.has(value)) value = "other";
    out[key] = value;
  }
  return out;
}

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function urlBase(value: unknown): string {
  const out = asText(value).trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+$/.test(out)) return "";
  // 统计脚本在本应用的 origin 下执行，http 会被中间人整段替换成任意 JS。
  // 只允许本地回环走 http，其余必须是 https。
  if (!LOOPBACK.test(out) && !/^https:\/\//i.test(out)) return "";
  return out;
}

export function resolveConfig(raw: RawAnalyticsConfig | null | undefined): AnalyticsConfig {
  const providerText = asText(raw?.provider).trim().toLowerCase();
  const provider: AnalyticsProvider =
    providerText === "plausible" || providerText === "posthog" ? providerText : "none";
  const domain = asText(raw?.domain)
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  // 显式写了 host 但格式不对时降级为不启用：宁可少统计，也不悄悄把数据发到默认站点。
  const hostInput = asText(raw?.host).trim();
  let host = urlBase(hostInput);
  if (!host && !hostInput && provider !== "none") host = DEFAULT_HOST[provider];
  const key = asText(raw?.key).trim();
  let enabled = false;
  if (provider === "plausible") enabled = Boolean(domain) && Boolean(host);
  if (provider === "posthog") enabled = Boolean(key) && Boolean(host);
  return { provider, domain, host, key, enabled };
}

interface PostHogLike {
  init(key: string, options: Record<string, unknown>): void;
  capture(name: string, props: Record<string, string>): void;
}

declare global {
  interface Window {
    /** 部署期配置，由 /config.js（运行时路由）挂上来。 */
    __WEAVE_CONFIG__?: {
      analytics?: RawAnalyticsConfig;
      /** 服务端 isProductionLike() 的现算结果，见 src/runtime-mode.ts。 */
      productionLike?: boolean;
    };
    plausible?: (...args: unknown[]) => void;
    posthog?: PostHogLike;
  }
}

/* null = 部署期配置还没到（/config.js 没加载完），此时所有上报都静默丢弃。 */
let cached: AnalyticsConfig | null = null;

/**
 * 应用一份配置。重复调用是安全的；未启用时什么也不做。
 * 值来自 `/config.js`（容器环境变量 ANALYTICS_*），不用 NEXT_PUBLIC_*。
 */
export function applyAnalyticsConfig(raw: RawAnalyticsConfig | null | undefined): AnalyticsConfig {
  cached = resolveConfig(raw);
  if (cached.enabled) initAnalytics();
  return cached;
}

/** 从 window.__WEAVE_CONFIG__ 读一次；没有配置就当没开。 */
export function syncAnalyticsConfig(): AnalyticsConfig {
  if (typeof window === "undefined") return applyAnalyticsConfig(null);
  return applyAnalyticsConfig(window.__WEAVE_CONFIG__?.analytics);
}

/** 当前生效的配置；还没拿到部署期配置时为 null。 */
export function analyticsConfig(): AnalyticsConfig | null {
  return cached;
}

/* 演示模式（?demo=1 或本地存过 weave.demo=1）是内部看数据用的，不计入统计。 */
function suppressed(): boolean {
  if (typeof window === "undefined") return true;
  const nav = window.navigator;
  if (
    nav.doNotTrack === "1" ||
    (nav as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
  ) {
    return true;
  }
  try {
    if (window.localStorage.getItem("weave.demo") === "1") return true;
  } catch {
    // 隐私模式下 localStorage 会抛，忽略即可。
  }
  return new URLSearchParams(window.location.search).get("demo") === "1";
}

let started = false;
let ready = false;
const pending: Array<{ name: string; props: Record<string, string> }> = [];

function flush(): void {
  while (pending.length > 0) {
    const item = pending.shift();
    if (!item) break;
    send(item.name, item.props);
  }
}

function send(name: string, props: Record<string, string>): void {
  if (typeof window === "undefined" || !cached) return;
  if (cached.provider === "plausible") {
    window.plausible?.(name, { props });
    return;
  }
  window.posthog?.capture(name, props);
}

/**
 * 首次调用时注入 provider 脚本。没配置就是空函数，调用多少次都一样。
 * 由 <Analytics /> 在拿到部署期配置后调一次。
 */
export function initAnalytics(): void {
  if (started || typeof window === "undefined" || !cached) return;
  started = true;
  const cfg = cached;
  if (!cfg.enabled || suppressed()) return;

  const script = window.document.createElement("script");
  script.async = true;
  script.src =
    cfg.provider === "plausible" ? `${cfg.host}/js/script.js` : `${cfg.host}/static/array.js`;
  if (cfg.provider === "plausible") {
    script.setAttribute("data-domain", cfg.domain);
  }

  script.addEventListener("load", () => {
    if (cfg.provider === "posthog") {
      window.posthog?.init(cfg.key, {
        api_host: cfg.host,
        // 页码事件由这里统一发，两个 provider 的事件名才一致。
        capture_pageview: false,
        autocapture: false,
        disable_session_recording: true,
        persistence: "memory",
        person_profiles: "never",
      });
    }
    ready = true;
    flush();
  });

  window.document.head.appendChild(script);
}

/**
 * 上报一个事件。未配置、被 DNT 或演示模式拦下时返回 false，调用方不用分支。
 */
export function track(event: AnalyticsEvent, props?: Record<string, unknown>): boolean {
  if (typeof window === "undefined") return false;
  const cfg = cached;
  if (!cfg || !cfg.enabled || suppressed()) return false;
  const clean = sanitizeProps(event, props);
  if (!ready) {
    if (pending.length < MAX_QUEUE) pending.push({ name: event, props: clean });
    return true;
  }
  send(event, clean);
  return true;
}

let firstPageview = true;

/**
 * 路由变化时调一次。Plausible 的脚本自己会发首屏 pageview，这里跳过第一次，
 * 避免同一页被记两次；PostHog 关掉了自动 pageview，所以每次都由这里发。
 */
export function trackPageview(): void {
  const cfg = cached;
  if (!cfg || !cfg.enabled) return;
  const skip = cfg.provider === "plausible" && (firstPageview || !ready);
  firstPageview = false;
  if (skip) return;
  track("pageview");
}
