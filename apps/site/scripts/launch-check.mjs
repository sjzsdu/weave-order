#!/usr/bin/env node
/**
 * 官网上线核查。
 *
 * 上线后最容易漏的不是页面本身，而是跳转、抓取入口和缓存头：
 * http 是否只跳一次、robots 里的 sitemap 是不是最终域名、404 是不是真 404、
 * OG 图能不能打开、HTML 会不会被缓存住。这些用浏览器看不出来，只能打请求看。
 *
 * 用法：
 *   node apps/site/scripts/launch-check.mjs --site https://weaveorder.cn
 *   WEAVE_SITE_URL=https://… node apps/site/scripts/launch-check.mjs
 *   node apps/site/scripts/launch-check.mjs --site http://127.0.0.1:8080  # 本地预览
 *
 * 退出码：0 = 全部通过（提醒不影响）；1 = 有失败项。
 *
 * 覆盖不到、必须人工看的：LCP / CLS（用 Chrome DevTools 或 PageSpeed Insights，
 * 手机 390px 与桌面 1440 各跑一次）、GSC / Bing / 百度的后台状态。
 */

const args = process.argv.slice(2);

function flagValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "用法：node apps/site/scripts/launch-check.mjs --site https://example.com [--skip-www] [--skip-perf]",
  );
  process.exit(0);
}

const rawSite = flagValue("--site") ?? process.env.WEAVE_SITE_URL;
if (!rawSite) {
  console.error("缺少站点地址：传 --site 或设置 WEAVE_SITE_URL");
  process.exit(1);
}

let site;
try {
  site = new URL(rawSite);
} catch {
  console.error(`站点地址不合法：${rawSite}`);
  process.exit(1);
}
if (!site.pathname.endsWith("/")) site.pathname += "/";

const skipWww = args.includes("--skip-www");
const skipPerf = args.includes("--skip-perf");
const origin = site.origin;
const host = site.host;
const expectWww = host.startsWith("www.") ? host : `www.${host}`;
const bareHost = host.startsWith("www.") ? host.slice(4) : host;

const results = [];

function pass(name, detail = "") {
  results.push({ ok: true, name, detail });
}

function fail(name, detail) {
  results.push({ ok: false, name, detail });
}

function warn(name, detail) {
  results.push({ ok: true, warning: true, name, detail });
}

function msg(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 手动跟随跳转，返回最终响应与跳转链；超过 6 跳直接判失败。 */
async function follow(start) {
  const chain = [];
  let current = start;
  for (let i = 0; i < 6; i++) {
    const response = await fetch(current, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      chain.push({
        url: current,
        status: response.status,
        location: response.headers.get("location"),
      });
      current = new URL(response.headers.get("location"), current).href;
      continue;
    }
    return { response, chain, finalUrl: current };
  }
  throw new Error(`跳转超过 6 次：${start}`);
}

async function checkRedirect(startUrl, label) {
  const { response, chain, finalUrl } = await follow(startUrl);
  const final = new URL(finalUrl);
  const targetOk = final.origin === origin && final.pathname === "/";
  if (response.status !== 200) {
    fail(`${label}跳转`, `${startUrl} 最终状态 ${response.status}`);
    return;
  }
  if (!targetOk) {
    fail(`${label}跳转`, `${startUrl} 最终落到 ${final.origin}${final.pathname}，期望 ${origin}/`);
    return;
  }
  if (chain.length > 1) {
    fail(
      `${label}跳转`,
      `${startUrl} 跳了 ${chain.length} 次：${chain.map((hop) => `${hop.status}→${hop.location}`).join("，")}`,
    );
    return;
  }
  pass(
    `${label}跳转`,
    chain.length === 0 ? "无跳转" : `${chain[0].status} → ${final.origin}/（1 次）`,
  );
}

async function timed(url, init) {
  const started = performance.now();
  const response = await fetch(url, init);
  const ttfb = performance.now() - started;
  const body = await response.text();
  return { response, body, ttfb, total: performance.now() - started };
}

const homeUrl = new URL("/", origin).href;

/* ------------------------------------------------------------------ 跳转 */
try {
  if (site.protocol === "https:") {
    await checkRedirect(`http://${host}/`, "http→https ");
    if (!skipWww) {
      const alternative = site.origin.includes(`//${bareHost}`) ? expectWww : bareHost;
      const altUrl = `https://${alternative}/`;
      if (alternative !== host)
        await checkRedirect(altUrl, `${alternative === expectWww ? "裸域→www" : "www→裸域"}`);
    }
  } else {
    warn("跳转检查", "本地或 http 站点，跳过 http→https 与 www 归一化检查");
  }
} catch (error) {
  fail("跳转检查", msg(error));
}

/* ------------------------------------------------------------------ 首页 */
let homeBody = "";
try {
  const { response, body, ttfb, total } = await timed(homeUrl);
  homeBody = body;
  if (response.status !== 200) {
    fail("首页", `${homeUrl} 返回 ${response.status}`);
  } else if (!/text\/html/.test(response.headers.get("content-type") ?? "")) {
    fail("首页", `Content-Type 不是 HTML：${response.headers.get("content-type")}`);
  } else if (
    !new RegExp(
      `<link[^>]+rel="canonical"[^>]+href="${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?"`,
    ).test(body)
  ) {
    fail("首页 canonical", `canonical 不是 ${origin}/`);
  } else {
    pass("首页", `200，TTFB ${Math.round(ttfb)}ms，总耗时 ${Math.round(total)}ms`);
  }
  if (!skipPerf) {
    if (ttfb > 1000) warn("首字节", `TTFB ${Math.round(ttfb)}ms，静态站应 < 1000ms`);
    if (total > 2000) warn("首屏加载", `HTML 总耗时 ${Math.round(total)}ms，静态站应 < 2000ms`);
  }
} catch (error) {
  fail("首页", msg(error));
}

/* ------------------------------------------------------------------ 抓取入口 */
try {
  const { response, body } = await timed(new URL("/robots.txt", origin).href);
  if (response.status !== 200) fail("robots.txt", `返回 ${response.status}`);
  else if (!body.includes(`Sitemap: ${origin}/sitemap.xml`)) {
    fail("robots.txt", `没有指向 ${origin}/sitemap.xml（域名没渲染？）`);
  } else pass("robots.txt", "200，sitemap 指向当前域名");
} catch (error) {
  fail("robots.txt", msg(error));
}

let sitemapUrls = [];
try {
  const { response, body } = await timed(new URL("/sitemap.xml", origin).href);
  if (response.status !== 200) fail("sitemap.xml", `返回 ${response.status}`);
  else {
    sitemapUrls = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => match[1]);
    const foreign = sitemapUrls.filter((url) => {
      try {
        return new URL(url).origin !== origin;
      } catch {
        return true;
      }
    });
    if (sitemapUrls.length === 0) fail("sitemap.xml", "没有 <loc>");
    else if (foreign.length > 0)
      fail(
        "sitemap.xml",
        `${foreign.length} 条地址不属于 ${origin}：${foreign.slice(0, 3).join(", ")}`,
      );
    else pass("sitemap.xml", `${sitemapUrls.length} 条地址，全部是当前域名`);
  }
} catch (error) {
  fail("sitemap.xml", msg(error));
}

try {
  const { response, body } = await timed(new URL("/llms.txt", origin).href);
  if (response.status !== 200) fail("llms.txt", `返回 ${response.status}`);
  else if (!body.includes("织序")) fail("llms.txt", "内容缺少站点名称");
  else pass("llms.txt", "200");
} catch (error) {
  fail("llms.txt", msg(error));
}

/* ------------------------------------------------------------------ OG 图 */
try {
  const match = homeBody.match(/property="og:image"\s+content="([^"]+)"/);
  if (!match) {
    fail("OG 图", "首页缺 og:image");
  } else {
    const ogUrl = new URL(match[1], origin);
    const response = await fetch(ogUrl, { redirect: "manual" });
    if (response.status !== 200) fail("OG 图", `${ogUrl.href} 返回 ${response.status}`);
    else if (!/^image\//.test(response.headers.get("content-type") ?? "")) {
      fail("OG 图", `Content-Type 不是图片：${response.headers.get("content-type")}`);
    } else pass("OG 图", `200，${response.headers.get("content-type")}`);
  }
} catch (error) {
  fail("OG 图", msg(error));
}

/* ------------------------------------------------------------------ 404 */
try {
  const url = new URL("/__launch-check-not-found__", origin).href;
  const { response, body } = await timed(url);
  if (response.status !== 404) fail("404 页", `期望 404，实际 ${response.status}`);
  else if (!/404/.test(body)) fail("404 页", "状态码是 404，但返回的不是站点自己的 404.html");
  else pass("404 页", "404 + 站点自己的 404 页面");
} catch (error) {
  fail("404 页", msg(error));
}

/* ------------------------------------------------------------------ 缓存与压缩 */
try {
  const response = await fetch(homeUrl);
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (!/no-cache|no-store|max-age=0/.test(cacheControl)) {
    fail("HTML 缓存", `Cache-Control 是「${cacheControl || "<空>"}」，换域名后会残留旧域名`);
  } else pass("HTML 缓存", cacheControl);
} catch (error) {
  fail("HTML 缓存", msg(error));
}

try {
  const response = await fetch(new URL("/assets/logo-mark.svg", origin).href);
  const cacheControl = response.headers.get("cache-control") ?? "";
  const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1] ?? 0);
  if (response.status !== 200) fail("静态资源缓存", `logo 返回 ${response.status}`);
  else if (maxAge < 86400) fail("静态资源缓存", `max-age=${maxAge}，应 ≥ 86400 秒`);
  else pass("静态资源缓存", cacheControl);
} catch (error) {
  fail("静态资源缓存", msg(error));
}

try {
  const response = await fetch(homeUrl, { headers: { "accept-encoding": "gzip" } });
  const encoding = response.headers.get("content-encoding") ?? "";
  if (/gzip|br/.test(encoding)) pass("文本压缩", encoding);
  else warn("文本压缩", "响应没有 Content-Encoding，确认 nginx / CDN 已开启 gzip 或 brotli");
} catch (error) {
  warn("文本压缩", msg(error));
}

/* ------------------------------------------------------------------ 报告 */
console.log(`\n官网上线核查 · ${origin}\n`);
for (const result of results) {
  const mark = result.ok ? (result.warning ? "!" : "✓") : "✗";
  console.log(`${mark} ${result.name}${result.detail ? `：${result.detail}` : ""}`);
}

const failed = results.filter((result) => !result.ok).length;
const warned = results.filter((result) => result.warning).length;
console.log(
  `\n结果：${results.length - failed - warned} 项通过，${failed} 项失败，${warned} 项提醒。`,
);

if (sitemapUrls.length > 0) {
  console.log(
    `人工复核：PageSpeed Insights 跑首页与价格页（手机 390px / 桌面 1440），LCP < 2.5s。`,
  );
}

process.exit(failed > 0 ? 1 : 0);
