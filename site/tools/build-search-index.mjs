/**
 * 生成站内搜索索引：把 17 个静态页面拆成「页面 → 章节」的结构。
 *
 *   node site/tools/build-search-index.mjs
 *
 * 为什么在构建期做：官网是纯静态托管，运行时没有后端；把索引预先算好，
 * 浏览器只需要一次 fetch + 本地匹配，中文也能按二元组命中。
 * 产物 site/assets/search-index.json 一并提交，托管时无需 Node。
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "..");

const SKIP = new Set(["404.html"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "assets" || entry === "tools" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".html") && !SKIP.has(entry)) out.push(full);
  }
  return out;
}

function decode(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&hellip;/g, "…");
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

function meta(html, name) {
  const match = html.match(new RegExp(`<meta[^>]+name="${name}"[^>]+content="([^"]*)"`, "i"));
  return match ? decode(match[1]) : "";
}

function title(html) {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  return match ? strip(match[1]) : "";
}

/** 按 h2/h3 切片：抓标题后的正文，直到下一个标题。 */
function sections(html) {
  const body = html
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  const parts = body.split(/<h([23])([^>]*)>/i);
  const out = [];
  // parts: [前言, level, attrs, 内容, level, attrs, 内容, ...]
  for (let i = 1; i < parts.length; i += 3) {
    const attrs = parts[i + 1] ?? "";
    const chunk = parts[i + 2] ?? "";
    const headingHtml = chunk.slice(0, chunk.indexOf("</h"));
    const rest = chunk.slice(chunk.indexOf("</h") + 5);
    const idMatch = attrs.match(/id="([^"]+)"/i);
    const heading = strip(headingHtml);
    const text = strip(rest);
    if (heading) out.push({ id: idMatch ? idMatch[1] : null, heading, text: text.slice(0, 1200) });
  }
  return out;
}

const pages = walk(siteDir).map((file) => {
  const html = readFileSync(file, "utf8");
  const rel = relative(siteDir, file).split("\\").join("/");
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return {
    url: rel,
    title: title(html),
    heading: h1 ? strip(h1[1]) : "",
    description: meta(html, "description"),
    text: strip(html).slice(0, 4000),
    sections: sections(html),
  };
});

const payload = {
  generatedAt: new Date().toISOString().slice(0, 10),
  pages,
};

const out = join(siteDir, "assets", "search-index.json");
writeFileSync(out, JSON.stringify(payload), "utf8");
console.log(
  `wrote ${out}（${pages.length} 页，${pages.reduce((n, p) => n + p.sections.length, 0)} 节）`,
);
