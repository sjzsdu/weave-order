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

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join("\n") + "\n", "utf8");

console.log(`已生成 ${outPath}：`);
for (const line of lines) console.log(`  ${line}`);
