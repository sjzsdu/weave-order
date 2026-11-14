/**
 * 把 src/site.config.json 解析成运行时可读的默认值。
 *
 * 官网已经并入主镜像（跑 Node），所以这一步在容器启动时做：
 *   直接读镜像里的 site.config.json，产出一份 KEY=value 的默认表，
 *   entrypoint.sh 用 shell 读取，再按部署环境的环境变量覆盖。
 *
 * 用法：node prepare-config.mjs <site.config.json> <out/defaults.env>
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [configPath, outPath] = process.argv.slice(2);
if (!configPath || !outPath) {
  console.error("用法：node prepare-config.mjs <site.config.json> <out/defaults.env>");
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));

// 顺序即 site.config.json 的字段顺序；entrypoint 按同样的名字读环境变量覆盖。
const KEYS = ["site", "app", "admin", "sso", "email"];

/**
 * 访问统计的默认值。四个值都允许为空（空 = 不统计），
 * 但字符集要收紧：它们会被写进页面里的 JSON 字符串，出现引号或反斜杠就会破坏语法。
 */
const ANALYTICS_KEYS = ["provider", "domain", "host", "key"];
const ANALYTICS_DEFAULTS = { provider: "none", domain: "", host: "", key: "" };
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function analyticsValues(raw) {
  const merged = { ...ANALYTICS_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  const out = {};
  for (const key of ANALYTICS_KEYS) out[key] = String(merged[key] ?? "").trim();

  if (!["none", "plausible", "posthog"].includes(out.provider.toLowerCase())) {
    console.error(`analytics.provider 只能是 plausible / posthog / none：${out.provider}`);
    process.exit(1);
  }
  out.provider = out.provider.toLowerCase();

  if (out.domain && !/^[A-Za-z0-9.*:-]+$/.test(out.domain)) {
    console.error(`analytics.domain 只填域名：${out.domain}`);
    process.exit(1);
  }
  if (out.host && !/^https?:\/\/[^\s"\\]+$/.test(out.host)) {
    console.error(`analytics.host 必须是 http(s) 地址：${out.host}`);
    process.exit(1);
  }
  // 统计脚本在站点自己的 origin 下执行，非本地回环一律要求 https（防中间人替换）。
  if (out.host && !LOOPBACK.test(out.host) && !/^https:\/\//i.test(out.host)) {
    console.error(`analytics.host 必须用 https（本地回环除外）：${out.host}`);
    process.exit(1);
  }
  if (out.key && !/^[A-Za-z0-9_-]{8,128}$/.test(out.key)) {
    console.error(`analytics.key 只接受字母数字与 - _（8 到 128 位）：${out.key}`);
    process.exit(1);
  }
  return out;
}

const lines = [];
for (const key of KEYS) {
  const value = String(config[key] ?? "").trim();
  if (!value) {
    console.error(`site.config.json 缺少 ${key}`);
    process.exit(1);
  }
  if (key === "email") {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      console.error(`email 格式不对：${value}`);
      process.exit(1);
    }
  } else if (!/^https?:\/\/[^\s]+$/.test(value)) {
    console.error(`${key} 必须是 http(s) 地址：${value}`);
    process.exit(1);
  }
  // JSON.stringify 产出双引号形式，shell source 时不会被空格或 $ 拆开。
  lines.push(`${key.toUpperCase()}=${JSON.stringify(value)}`);
}

const analytics = analyticsValues(config.analytics);
for (const key of ANALYTICS_KEYS) {
  lines.push(`ANALYTICS_${key.toUpperCase()}=${JSON.stringify(analytics[key])}`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join("\n") + "\n", "utf8");

console.log(`已生成 ${outPath}：`);
for (const line of lines) console.log(`  ${line}`);
