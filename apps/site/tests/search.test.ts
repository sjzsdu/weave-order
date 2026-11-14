/**
 * 站内搜索：用真实构建产物里的索引跑查询，确保「搜得到、搜得准」。
 *
 * 不 mock 索引：索引是构建生成的，测试直接读 dist/search-index.json，
 * 索引生成器坏了（漏页、章节没切开）这里会立刻失败。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { searchPages, terms } from "../src/lib/search";
import type { SearchPage } from "../src/lib/search";

const distDir = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
const indexPath = join(distDir, "search-index.json");

function loadPages(): SearchPage[] {
  const payload = JSON.parse(readFileSync(indexPath, "utf8")) as { pages: SearchPage[] };
  return payload.pages;
}

function urlsFor(query: string): string[] {
  return searchPages(loadPages(), query).map((hit) => hit.url);
}

describe("站内搜索索引", () => {
  it("构建产物里生成了索引，且覆盖全部可索引页面", () => {
    expect(existsSync(indexPath), "缺少 dist/search-index.json").toBe(true);
    const pages = loadPages();
    expect(pages.length).toBe(20);
    const urls = pages.map((page) => page.url);
    expect(urls).toContain("/");
    expect(urls).toContain("/pricing.html");
    expect(urls).toContain("/docs/quotes.html");
    expect(urls).toContain("/guides/textile-erp-selection.html");
    expect(urls).not.toContain("/404.html");
    // 每个页面都要有标题；帮助中心每篇都要切出章节，否则锚点搜索无从谈起
    for (const page of pages) {
      expect(page.title.length, `${page.url} 缺标题`).toBeGreaterThan(0);
    }
    expect(pages.find((page) => page.url === "/docs/quotes.html")?.sections.length).toBeGreaterThan(
      3,
    );
  });

  it("中文按二元组切词，英文按词切", () => {
    expect(terms("报价单")).toEqual(["报价", "价单"]);
    expect(terms("Excel")).toEqual(["excel"]);
    expect(terms("")).toEqual([]);
  });

  it("中文关键词能命中对应页面", () => {
    expect(urlsFor("报价")).toContain("/docs/quotes.html");
    expect(urlsFor("审批")).toContain("/docs/approvals.html");
    expect(urlsFor("发票")).not.toHaveLength(0);
  });

  it("英文关键词能命中对应页面", () => {
    expect(urlsFor("Excel")).toContain("/docs/import.html");
  });

  it("结果带章节锚点，能直接落在正文那一段", () => {
    const hit = searchPages(loadPages(), "改价").find((item) => item.url === "/docs/quotes.html");
    expect(hit, "没找到「改价」").toBeTruthy();
    expect(hit?.anchor.startsWith("#")).toBe(true);
    expect(hit?.section.length).toBeGreaterThan(0);
  });

  it("无关键词时返回空结果，不把整站倒出来", () => {
    expect(searchPages(loadPages(), "   ")).toEqual([]);
    expect(urlsFor("zzzqqq")).toEqual([]);
    expect(urlsFor("龘龘")).toEqual([]);
  });
});
