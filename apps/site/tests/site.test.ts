/**
 * 官网构建产物的体检。
 *
 * 官网是营销站，坏掉的代价不对称：链接 404、canonical 丢失、JSON-LD 语法错误，
 * 搜索引擎和用户都会立刻发现，而这些问题在代码里看不出来。
 * 所以对构建产物直接做体检：文件在不在、链接通不通、元信息齐不齐。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distDir = resolve(fileURLToPath(new URL("../dist", import.meta.url)));

/** 站点该有的页面（与旧站地址一致，改地址要连 sitemap 一起改）。 */
const PAGES = [
  "index.html",
  "pricing.html",
  "signup.html",
  "download.html",
  "login.html",
  "legal.html",
  "404.html",
  "docs/index.html",
  "docs/quickstart.html",
  "docs/signup.html",
  "docs/import.html",
  "docs/approvals.html",
  "docs/quotes.html",
  "docs/printing.html",
  "docs/agent.html",
  "docs/security.html",
  "docs/faq.html",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const htmlFiles = existsSync(distDir) ? walk(distDir).filter((f) => f.endsWith(".html")) : [];

describe("官网构建产物", () => {
  it("每个页面都产出了", () => {
    for (const page of PAGES) {
      expect(existsSync(join(distDir, page)), `缺少 ${page}`).toBe(true);
    }
    expect(htmlFiles.length).toBe(PAGES.length);
  });

  it("每页都有 title、description、canonical", () => {
    for (const page of PAGES) {
      const html = readFileSync(join(distDir, page), "utf8");
      expect(html, `${page} 缺 title`).toMatch(/<title>[^<]+<\/title>/);
      expect(html, `${page} 缺 description`).toMatch(
        /<meta[^>]*name="description"[^>]*content="[^"]+"/,
      );
      if (page !== "404.html") {
        expect(html, `${page} 缺 canonical`).toMatch(
          /<link[^>]*rel="canonical"[^>]*href="https?:\/\//,
        );
      }
    }
  });

  it("JSON-LD 都是合法 JSON", () => {
    for (const page of PAGES) {
      const html = readFileSync(join(distDir, page), "utf8");
      for (const match of html.matchAll(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi,
      )) {
        expect(() => {
          JSON.parse(match[1]);
        }, `${page} 的 JSON-LD 解析失败`).not.toThrow();
      }
    }
  });

  it("站内链接都指向存在的文件", () => {
    const broken: string[] = [];
    for (const file of htmlFiles) {
      const html = readFileSync(file, "utf8");
      const from = relative(distDir, file);
      for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const href = match[1];
        if (!href.startsWith("/") || href.startsWith("//")) continue;
        const clean = href.split("#")[0]?.split("?")[0];
        if (!clean || clean === "/") continue;
        const target = join(distDir, clean);
        const asDir = join(distDir, clean, "index.html");
        if (!existsSync(target) && !existsSync(asDir)) broken.push(`${from} → ${href}`);
      }
    }
    expect(broken, `站内链接指向不存在的文件：\n${broken.join("\n")}`).toEqual([]);
  });

  it("sitemap 覆盖全部可索引页面", () => {
    const sitemap = readFileSync(join(distDir, "sitemap.xml"), "utf8");
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locations.length).toBe(16);
    for (const page of PAGES.filter((p) => p !== "404.html")) {
      const path = page === "index.html" ? "/" : page === "docs/index.html" ? "/docs/" : `/${page}`;
      expect(
        locations.some((loc) => loc.endsWith(path)),
        `sitemap 少了 ${path}`,
      ).toBe(true);
    }
  });

  it("给 AI 助手的摘要与抓取规则都在", () => {
    expect(existsSync(join(distDir, "llms.txt"))).toBe(true);
    const robots = readFileSync(join(distDir, "robots.txt"), "utf8");
    expect(robots).toMatch(/Sitemap: https?:\/\//);
    expect(robots).toMatch(/GPTBot/);
  });
});
