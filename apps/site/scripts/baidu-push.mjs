#!/usr/bin/env node
/**
 * 百度搜索资源平台「主动推送」。
 *
 * 百度不会像 Google 那样自己很快发现新页面，主动推送能让新发布的页面当天进队列。
 * 推送的是 sitemap 里的全部地址（默认读线上 sitemap.xml，已与运行期域名一致）。
 *
 * 用法：
 *   BAIDU_PUSH_TOKEN=xxxx node apps/site/scripts/baidu-push.mjs --site https://weaveorder.cn
 *   node apps/site/scripts/baidu-push.mjs --site https://… --token … --sitemap ./dist/sitemap.xml
 *   node apps/site/scripts/baidu-push.mjs --site https://… --dry-run   # 只打印要推的地址
 *
 * 参数：
 *   --site <url>        站点地址；也可用环境变量 WEAVE_SITE_URL
 *   --token <token>     百度推送 token；也可用 BAIDU_PUSH_TOKEN
 *   --sitemap <url|path> 默认 <site>/sitemap.xml；本地文件路径也可以
 *   --limit <n>         单次最多推送多少条（百度单次上限 10000，默认全部）
 *   --dry-run           不真正推送，只打印
 *
 * 退出码：0 = 推送成功或未配置 token（部署流水线不该因为没开通百度就失败）；
 *         1 = 抓取 sitemap 失败、参数错误或百度返回 success=0。
 *
 * 注意：百度接口只接受同站地址；本脚本会按站点 host 过滤 sitemap 里的地址。
 */

import { readFile } from "node:fs/promises";

const PUSH_ENDPOINT = "http://data.zz.baidu.com/urls";

function parseArgs(argv) {
  const out = { limit: Infinity, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--site":
        out.site = argv[++i];
        break;
      case "--token":
        out.token = argv[++i];
        break;
      case "--sitemap":
        out.sitemap = argv[++i];
        break;
      case "--limit":
        out.limit = Number(argv[++i]);
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return out;
}

function usage() {
  console.log(`用法：
  BAIDU_PUSH_TOKEN=… node apps/site/scripts/baidu-push.mjs --site https://weaveorder.cn [--sitemap <url|path>] [--limit N] [--dry-run]`);
}

function normalizeSite(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`站点地址必须是 http(s)：${raw}`);
  }
  return url;
}

async function loadSitemap(location) {
  if (/^https?:\/\//i.test(location)) {
    const res = await fetch(location, {
      headers: { accept: "application/xml,text/xml,*/*" },
    });
    if (!res.ok) throw new Error(`抓取 sitemap 失败：${res.status} ${location}`);
    return await res.text();
  }
  return await readFile(location, "utf8");
}

function extractLocations(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return 0;
  }

  const rawSite = args.site ?? process.env.WEAVE_SITE_URL;
  if (!rawSite) {
    throw new Error("缺少站点地址：传 --site 或设置 WEAVE_SITE_URL");
  }
  const site = normalizeSite(rawSite);
  const token = args.token ?? process.env.BAIDU_PUSH_TOKEN ?? "";

  if (Number.isNaN(args.limit) || args.limit < 1) {
    throw new Error("--limit 必须是正整数");
  }

  // 未配置 token 属于正常状态（还没开通百度推送），不当作部署失败；
  // --dry-run 不推送，所以没有 token 也可以演练。
  if (!token && !args.dryRun) {
    console.log("未配置 BAIDU_PUSH_TOKEN，跳过百度主动推送。");
    return 0;
  }
  if (token && !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("BAIDU_PUSH_TOKEN 只接受字母数字与 - _");
  }

  const sitemapLocation = args.sitemap ?? new URL("/sitemap.xml", site).href;
  const xml = await loadSitemap(sitemapLocation);
  const locations = extractLocations(xml);

  if (locations.length === 0) {
    throw new Error(`sitemap 里没有 <loc>：${sitemapLocation}`);
  }

  // 百度只收同站地址；跨域地址传过去会被计入 not_same_site，先过滤掉。
  const sameSite = locations.filter((loc) => {
    try {
      return new URL(loc).host === site.host;
    } catch {
      return false;
    }
  });
  const urls = sameSite.slice(0, args.limit);

  console.log(`sitemap：${sitemapLocation}（${locations.length} 条，同站 ${sameSite.length} 条）`);
  for (const url of urls) console.log(`  ${url}`);

  if (args.dryRun) {
    console.log(`--dry-run：不推送，共 ${urls.length} 条。`);
    return 0;
  }

  const endpoint = `${PUSH_ENDPOINT}?site=${encodeURIComponent(site.host)}&token=${encodeURIComponent(token)}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: urls.join("\n"),
  });

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`百度返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }

  if (!res.ok || !payload || payload.success === 0 || payload.success == null) {
    const detail = payload?.message ?? payload?.error ?? text;
    throw new Error(`百度推送失败（HTTP ${res.status}）：${detail}`);
  }

  console.log(`推送完成：success=${payload.success} remain=${payload.remain ?? "?"}`);
  if (Array.isArray(payload.not_same_site) && payload.not_same_site.length > 0) {
    console.log(`百度判定非同站（已跳过 ${payload.not_same_site.length} 条）`);
  }
  if (Array.isArray(payload.not_valid) && payload.not_valid.length > 0) {
    console.log(
      `百度判定无效地址 ${payload.not_valid.length} 条：\n  ${payload.not_valid.join("\n  ")}`,
    );
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`百度主动推送失败：${error.message}`);
    process.exitCode = 1;
  });
