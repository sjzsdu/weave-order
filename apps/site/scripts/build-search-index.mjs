/**
 * 站内搜索索引：构建完成后从 dist 的 HTML 里抽取「页面 → 章节」结构。
 *
 *   node scripts/build-search-index.mjs        # 由 npm run build 在 astro build 之后调用
 *
 * 为什么在构建期做：官网是纯静态托管，运行时没有后端。索引预先算好，
 * 浏览器一次 fetch + 本地匹配，中文按二元组命中，不联网、不埋点。
 *
 * 为什么读 dist 而不是读内容集合：搜索要覆盖首页、价格、下载、登录这些
 * 非 Markdown 页面，只有渲染后的 HTML 才是它们的最终文案（含导航外的正文）。
 * 同时把 <header>/<footer>/<aside>/<nav> 剔掉，避免每篇文档都命中侧栏目录。
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(siteDir, "dist");

/** 不索引的页面：错误页与搜索页本身不该出现在结果里。 */
const SKIP = new Set(["404.html", "search.html"]);

function decode(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&hellip;/g, "…")
    .replace(/&middot;/g, "·");
}

function strip(html) {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** 页面骨架里重复出现的区域，先整块去掉再抽正文。 */
function mainRegion(html) {
  return html
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ");
}

function meta(html, name) {
  const match = html.match(new RegExp(`<meta[^>]+name="${name}"[^>]+content="([^"]*)"`, "i"));
  return match ? decode(match[1]) : "";
}

function title(html) {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  // 标题形如「价格 · 织序 WeaveOrder」，搜索结果里去掉品牌后缀更短。
  return strip(match[1]).replace(/\s*[·|—-]\s*织序.*$/, "");
}

/** 按 h2/h3 切片：抓标题后的正文，直到下一个标题。 */
function sections(html) {
  const parts = html.split(/<h([23])([^>]*)>/i);
  const out = [];
  // parts: [前言, level, attrs, 内容, level, attrs, 内容, ...]
  for (let i = 1; i < parts.length; i += 3) {
    const attrs = parts[i + 1] ?? "";
    const chunk = parts[i + 2] ?? "";
    const end = chunk.indexOf("</h");
    const heading = strip(end === -1 ? chunk : chunk.slice(0, end));
    const rest = end === -1 ? "" : chunk.slice(end + 5);
    const idMatch = attrs.match(/id="([^"]+)"/i);
    const text = strip(rest);
    if (heading) out.push({ id: idMatch ? idMatch[1] : null, heading, text: text.slice(0, 1200) });
  }
  return out;
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir)) {
    if (entry.startsWith(".") || entry === "_astro") continue;
    const full = path.join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) out.push(...(await walk(full)));
    else if (entry.endsWith(".html") && !SKIP.has(entry)) out.push(full);
  }
  return out;
}

const files = await walk(distDir);
const pages = [];

for (const file of files) {
  const html = await readFile(file, "utf8");
  const rel = path.relative(distDir, file).split(path.sep).join("/");
  const body = mainRegion(html);
  const h1 = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  pages.push({
    // 根路径是 /，其余与站点地址一致（xxx.html）
    url: rel === "index.html" ? "/" : `/${rel}`,
    title: title(html),
    heading: h1 ? strip(h1[1]) : "",
    description: meta(html, "description"),
    text: strip(body).slice(0, 4000),
    sections: sections(body),
  });
}

const payload = {
  generatedAt: new Date().toISOString().slice(0, 10),
  pages,
};

const out = path.join(distDir, "search-index.json");
await writeFile(out, JSON.stringify(payload), "utf8");
const sectionCount = pages.reduce((n, page) => n + page.sections.length, 0);
console.log(`[search] 索引已生成：${pages.length} 页，${sectionCount} 节 → dist/search-index.json`);
