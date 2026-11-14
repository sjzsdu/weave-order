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
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "..");
const configPath = join(siteDir, "site.config.json");

const TARGET_EXT = new Set([".html", ".txt", ".xml"]);

function usage(message) {
  if (message) console.error("错误：" + message);
  console.error(
    [
      "用法：node site/tools/configure.mjs [--site URL] [--app URL] [--admin URL] [--sso URL] [--email ADDR] [--dry-run]",
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

const allowed = new Set(["site", "app", "admin", "sso", "email"]);
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

const config = JSON.parse(readFileSync(configPath, "utf8"));
const next = { ...config };

if (flags.site) next.site = normalizeUrl(flags.site, "--site");
if (flags.app) next.app = normalizeUrl(flags.app, "--app");
if (flags.admin) next.admin = normalizeUrl(flags.admin, "--admin");
if (flags.sso) next.sso = normalizeUrl(flags.sso, "--sso");
if (flags.email) next.email = normalizeEmail(flags.email);

const keys = ["site", "app", "admin", "sso", "email"];
const changes = keys.filter((key) => config[key] !== next[key]);

if (changes.length === 0) {
  console.log("配置没有变化。当前值：");
  for (const key of keys) console.log("  " + key.padEnd(6) + config[key]);
  process.exit(0);
}

// 长的先替换，避免 https://a.com 抢先吃掉 https://a.com.cn 这类前缀重叠。
const urlPairs = changes
  .map((key) => [config[key], next[key]])
  .sort((a, b) => b[0].length - a[0].length);

// 正文里也会出现不带协议的裸主机名（例如「打开 weave.wnbgj.com」），
// 放在 URL 替换之后处理；邮箱不参与这一轮。
const hostPairs = changes
  .filter((key) => key !== "email")
  .map((key) => [new URL(config[key]).host, new URL(next[key]).host])
  .filter(([from, to]) => from !== to)
  .sort((a, b) => b[0].length - a[0].length);

const pairs = [...urlPairs, ...hostPairs];

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
  let hits = 0;
  for (const [from, to] of pairs) {
    // 邮箱要同时覆盖 mailto: 与正文里的裸地址；URL 直接替换。
    const count = text.split(from).length - 1;
    if (count > 0) {
      text = text.split(from).join(to);
      hits += count;
    }
  }
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

if (!flags.dryRun) {
  writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(`已更新 ${touched} 个文件、${replaced} 处引用，并写回 site/site.config.json。`);
} else {
  console.log(`将更新 ${touched} 个文件、${replaced} 处引用（dry-run，未写入）。`);
}

// 提醒：应用侧还有两处部署期配置，不在这个脚本范围内。
console.log(
  [
    "",
    "另外两处需要在部署环境里设置，不在静态站内：",
    "  1. apps/web 的 NEXT_PUBLIC_MARKETING_URL（登录页「申请开通 / 帮助中心 / 返回官网」指向的官网地址）。",
    "  2. Casdoor 应用 weave-order-web 的回调地址必须包含 <应用域名>/auth/callback；不设 PUBLIC_APP_URL 时应用按请求来源推导。",
  ].join("\n"),
);
