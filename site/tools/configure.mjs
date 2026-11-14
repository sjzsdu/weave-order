/**
 * 官网部署期配置：把域名、应用地址、支持邮箱写进所有静态页面。
 *
 * 为什么不在页面里写死：SEO 需要绝对地址（canonical / og:image / sitemap），
 * 但具体域名是部署时才知道的。这里让「改一处」而不是「改 17 个文件」：
 * 读 site/site.config.json 里的旧值 → 全站替换 → 写回新值（可反复执行）。
 *
 *   node site/tools/configure.mjs --site https://weave.example.com
 *   node site/tools/configure.mjs --site https://a.com --app https://app.a.com --sso https://sso.a.com
 *   node site/tools/configure.mjs --dry-run          # 只看会改什么
 *
 * 支持的值：--site --app --admin --sso --email
 *           --analytics-provider --analytics-domain --analytics-host --analytics-key
 *
 * 统计配置不写进每个页面（那样 17 个文件都要改），而是生成一个
 * assets/analytics.config.js，页面统一引它。provider=none 时它写的就是空配置，
 * assets/analytics.js 读到空配置就什么都不做。
 *
 * 部署时也可以只用环境变量（命令行参数优先）：
 *   WEAVE_SITE_URL=https://weave.wnbgj.com \
 *   WEAVE_APP_URL=https://app.wnbgj.com \
 *   WEAVE_ADMIN_URL=https://admin.wnbgj.com \
 *   WEAVE_SSO_URL=https://sso.wnbgj.com \
 *   WEAVE_SUPPORT_EMAIL=hello@weaveorder.cn \
 *   node site/tools/configure.mjs
 *
 * 统计同理：WEAVE_ANALYTICS_PROVIDER / DOMAIN / HOST / KEY（命令行参数优先）。
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "..");
const configPath = join(siteDir, "site.config.json");
const analyticsConfigPath = join(siteDir, "assets", "analytics.config.js");

const TARGET_EXT = new Set([".html", ".txt", ".xml"]);

function usage(message) {
  if (message) console.error("错误：" + message);
  console.error(
    [
      "用法：node site/tools/configure.mjs [--site URL] [--app URL] [--admin URL] [--sso URL] [--email ADDR]",
      "                                    [--analytics-provider plausible|posthog|none] [--analytics-domain HOST]",
      "                                    [--analytics-host URL] [--analytics-key KEY] [--dry-run]",
      "",
      "  不带参数：按 site/site.config.json 当前值检查一遍，不修改。",
      "  带参数：把旧值全站替换为新值，并写回 site.config.json。",
    ].join("\n"),
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i += 1) {
  const key = args[i];
  if (key === "--dry-run") {
    flags.dryRun = true;
    continue;
  }
  if (!key.startsWith("--")) usage("无法识别的参数：" + key);
  const value = args[i + 1];
  if (!value || value.startsWith("--")) usage(key + " 需要一个值");
  flags[key.slice(2)] = value;
  i += 1;
}

const allowed = new Set([
  "site",
  "app",
  "admin",
  "sso",
  "email",
  "analytics-provider",
  "analytics-domain",
  "analytics-host",
  "analytics-key",
]);
for (const key of Object.keys(flags)) {
  if (key === "dryRun") continue;
  if (!allowed.has(key)) usage("未知的配置项：--" + key);
}

function normalizeUrl(value, label) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/.test(trimmed)) {
    usage(label + " 必须是 http(s) 开头的地址：" + value);
  }
  return trimmed;
}

function normalizeEmail(value) {
  const trimmed = value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) usage("邮箱格式不对：" + value);
  return trimmed;
}

const ANALYTICS_DEFAULTS = { provider: "none", domain: "", host: "", key: "" };

function normalizeProvider(value) {
  const trimmed = value.trim().toLowerCase();
  if (!["plausible", "posthog", "none"].includes(trimmed)) {
    usage("--analytics-provider 只能是 plausible / posthog / none：" + value);
  }
  return trimmed;
}

function normalizeDomainField(value) {
  const trimmed = value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!trimmed) return "";
  if (!/^[a-z0-9.*-]+(:\d+)?$/i.test(trimmed)) usage("--analytics-domain 只填域名：" + value);
  return trimmed;
}

function normalizeHostField(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (!/^https?:\/\/[^\s/]+$/.test(trimmed)) {
    usage("--analytics-host 必须是 http(s) 开头的地址：" + value);
  }
  return trimmed;
}

function normalizeKeyField(value) {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(trimmed)) {
    usage("--analytics-key 只接受字母数字与 - _（8 到 128 位）：" + value);
  }
  return trimmed;
}

/**
 * 统计配置生成：内容是确定的，重复执行只会重写出同样的字节。
 * 为什么不直接写进每个页面：provider 改成 none 时页面应该完全无感，
 * 只改一个 JS 文件最不容易漏；nginx 对这个文件设了 no-cache。
 */
function renderAnalyticsConfig(analytics) {
  const order = ["provider", "domain", "host", "key"];
  const body = order.map((key) => `  ${key}: ${JSON.stringify(analytics[key] ?? "")}`).join(",\n");
  return [
    "/* 织序 WeaveOrder · 访问统计配置",
    " *",
    " * 由 site/tools/configure.mjs 从 site/site.config.json 生成，不要手改。",
    " * 改法：容器启动时给 WEAVE_ANALYTICS_PROVIDER / DOMAIN / HOST / KEY，",
    " * 或本地跑 node site/tools/configure.mjs --analytics-provider ...",
    " *",
    " * provider：plausible | posthog | none。none 时 assets/analytics.js 完全静默，",
    " * 不注入第三方脚本、不发任何请求。也可以在页面里更早地写",
    " * window.WEAVE_ANALYTICS 覆盖这里。",
    " * 事件字典见 site/README.md「访问统计」。",
    " */",
    "",
    "window.WEAVE_ANALYTICS = {",
    body,
    "};",
    "",
  ].join("\n");
}

function syncAnalyticsConfig(analytics, dryRun) {
  const merged = { ...ANALYTICS_DEFAULTS, ...(analytics ?? {}) };
  const content = renderAnalyticsConfig(merged);
  let current = "";
  try {
    current = readFileSync(analyticsConfigPath, "utf8");
  } catch {
    current = "";
  }
  if (current === content) {
    console.log("  assets/analytics.config.js 已是最新（provider=" + merged.provider + "）。");
    return false;
  }
  console.log(
    (dryRun ? "[dry-run] " : "") +
      "  assets/analytics.config.js 按 provider=" +
      merged.provider +
      " 重写。",
  );
  if (!dryRun) writeFileSync(analyticsConfigPath, content, "utf8");
  return true;
}

const ENV_KEYS = {
  site: "WEAVE_SITE_URL",
  app: "WEAVE_APP_URL",
  admin: "WEAVE_ADMIN_URL",
  sso: "WEAVE_SSO_URL",
  email: "WEAVE_SUPPORT_EMAIL",
};

// 命令行优先；没传就看环境变量，方便部署流水线只注入 env。
for (const [key, envName] of Object.entries(ENV_KEYS)) {
  if (!flags[key] && process.env[envName]) flags[key] = process.env[envName];
}

const ANALYTICS_ENV_KEYS = {
  "analytics-provider": "WEAVE_ANALYTICS_PROVIDER",
  "analytics-domain": "WEAVE_ANALYTICS_DOMAIN",
  "analytics-host": "WEAVE_ANALYTICS_HOST",
  "analytics-key": "WEAVE_ANALYTICS_KEY",
};
for (const [key, envName] of Object.entries(ANALYTICS_ENV_KEYS)) {
  if (!flags[key] && process.env[envName]) flags[key] = process.env[envName];
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const next = { ...config };

if (flags.site) next.site = normalizeUrl(flags.site, "--site");
if (flags.app) next.app = normalizeUrl(flags.app, "--app");
if (flags.admin) next.admin = normalizeUrl(flags.admin, "--admin");
if (flags.sso) next.sso = normalizeUrl(flags.sso, "--sso");
if (flags.email) next.email = normalizeEmail(flags.email);

next.analytics = { ...ANALYTICS_DEFAULTS, ...(config.analytics ?? {}) };
if (flags["analytics-provider"] !== undefined) {
  next.analytics.provider = normalizeProvider(flags["analytics-provider"]);
}
if (flags["analytics-domain"] !== undefined) {
  next.analytics.domain = normalizeDomainField(flags["analytics-domain"]);
}
if (flags["analytics-host"] !== undefined) {
  next.analytics.host = normalizeHostField(flags["analytics-host"]);
}
if (flags["analytics-key"] !== undefined) {
  next.analytics.key = normalizeKeyField(flags["analytics-key"]);
}
if (next.analytics.provider === "none") {
  // provider 关掉时清空域名/密钥，避免配置里留着看似生效的值。
  next.analytics = { ...ANALYTICS_DEFAULTS };
}

const keys = ["site", "app", "admin", "sso", "email"];
const changes = keys.filter((key) => config[key] !== next[key]);
const analyticsChanged =
  JSON.stringify(config.analytics ?? null) !== JSON.stringify(next.analytics);

if (changes.length === 0 && !analyticsChanged) {
  syncAnalyticsConfig(next.analytics, flags.dryRun);
  console.log("配置没有变化。当前值：");
  for (const key of keys) console.log("  " + key.padEnd(10) + config[key]);
  console.log("  " + "analytics".padEnd(10) + JSON.stringify(next.analytics));
  process.exit(0);
}

// 两阶段替换：先把旧值换成唯一占位符，再统一写新值。
//
// 为什么不能顺序替换：新值可能正好等于另一项的旧值（典型场景：官网占用
// 原来应用的域名）。顺序替换会把刚写进去的地址再改一遍，canonical 会变成应用地址。
const tokens = new Map();
const urlPairs = [];
const hostPairs = [];

for (const key of changes) {
  const token = `\u0000WEAVE_${key.toUpperCase()}_URL\u0000`;
  tokens.set(token, next[key]);
  urlPairs.push([config[key], token]);

  if (key !== "email") {
    const oldHost = new URL(config[key]).host;
    const newHost = new URL(next[key]).host;
    if (oldHost !== newHost) {
      const hostToken = `\u0000WEAVE_${key.toUpperCase()}_HOST\u0000`;
      tokens.set(hostToken, newHost);
      hostPairs.push([oldHost, hostToken]);
    }
  }
}

urlPairs.sort((a, b) => b[0].length - a[0].length);
hostPairs.sort((a, b) => b[0].length - a[0].length);
const pairs = [...urlPairs, ...hostPairs];

// 支持邮箱单独保护：域名替换是按 host 匹配的，如果邮箱还用旧域名
// （hello@old.com 而站点迁到 new.com），host 替换会把邮箱一起改掉，
// 变成 hello@new.com 这种没人收信的地址。邮箱只能由 --email 显式改。
const protectEmail = !changes.includes("email") && config.email.includes("@");
const emailToken = "\u0000WEAVE_EMAIL\u0000";
if (protectEmail) tokens.set(emailToken, next.email);

function applyTokens(text) {
  let out = text;
  for (const [token, value] of tokens) out = out.split(token).join(value);
  return out;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "tools" || entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (TARGET_EXT.has(entry.slice(entry.lastIndexOf(".")))) out.push(full);
  }
  return out;
}

const files = walk(siteDir);
let touched = 0;
let replaced = 0;

for (const file of files) {
  let text = readFileSync(file, "utf8");
  if (protectEmail) text = text.split(config.email).join(emailToken);
  let hits = 0;
  for (const [from, to] of pairs) {
    // 邮箱要同时覆盖 mailto: 与正文里的裸地址；URL 直接替换。
    const count = text.split(from).length - 1;
    if (count > 0) {
      text = text.split(from).join(to);
      hits += count;
    }
  }
  if (hits > 0) text = applyTokens(text);
  if (hits > 0) {
    touched += 1;
    replaced += hits;
    const label = relative(siteDir, file);
    console.log((flags.dryRun ? "[dry-run] " : "") + label + "  " + hits + " 处");
    if (!flags.dryRun) writeFileSync(file, text, "utf8");
  }
}

for (const key of changes) {
  console.log("  " + key + "：" + config[key] + " → " + next[key]);
}

if (analyticsChanged) {
  console.log(
    "  analytics：" + JSON.stringify(config.analytics ?? null) + " → " + JSON.stringify(next.analytics),
  );
}

syncAnalyticsConfig(next.analytics, flags.dryRun);

if (!flags.dryRun) {
  writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(
    `已更新 ${touched} 个页面、${replaced} 处引用，重写 assets/analytics.config.js，并写回 site/site.config.json。`,
  );
} else {
  console.log(`将更新 ${touched} 个文件、${replaced} 处引用（dry-run，未写入）。`);
}

// 提醒：应用侧还有两处部署期配置，不在这个脚本范围内。
console.log(
  [
    "",
    "另外两处需要在部署环境里设置，不在静态站内：",
    "  1. 部署侧工作台容器的 MARKETING_URL / SUPPORT_EMAIL（登录页「申请开通 / 帮助中心 / 返回官网」与客服邮箱，运行时读取）。",
    "  2. Casdoor 应用 weave-order-web 的回调地址必须包含 <应用域名>/auth/callback；不设 PUBLIC_APP_URL 时应用按请求来源推导。",
  ].join("\n"),
);
