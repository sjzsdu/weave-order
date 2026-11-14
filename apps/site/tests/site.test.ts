/**
 * 官网构建产物的体检。
 *
 * 官网是营销站，坏掉的代价不对称：链接 404、canonical 丢失、JSON-LD 语法错误，
 * 搜索引擎和用户都会立刻发现，而这些问题在代码里看不出来。
 * 所以对构建产物直接做体检：文件在不在、链接通不通、元信息齐不齐。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
  "guides/textile-erp-selection.html",
  "guides/fabric-quotation-software.html",
  "guides/sample-follow-up.html",
  "guides/textile-reconciliation.html",
];

/** 长尾指南页：比普通页面多一层验收（结构化数据、单 h1、正文份量）。 */
const GUIDES = PAGES.filter((page) => page.startsWith("guides/"));

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
        // 站外地址、协议相对地址、页内锚点与 mailto 都不在这个检查范围。
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) continue;
        const clean = href.split("#")[0]?.split("?")[0];
        if (!clean) continue;
        // 相对链接按所在页面的目录解析：指南页用 ../docs/x.html 指回帮助中心，
        // 这类链接少写一级不会在代码里报错，只会在线上 404。
        const target = clean.startsWith("/")
          ? join(distDir, clean)
          : resolve(distDir, dirname(from), clean);
        const asDir = join(target, "index.html");
        if (!existsSync(target) && !existsSync(asDir)) broken.push(`${from} → ${href}`);
      }
    }
    expect(broken, `站内链接指向不存在的文件：\n${broken.join("\n")}`).toEqual([]);
  });

  it("sitemap 覆盖全部可索引页面", () => {
    const sitemap = readFileSync(join(distDir, "sitemap.xml"), "utf8");
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locations.length).toBe(20);
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

/**
 * 指南页的额外体检。
 *
 * 这四页是搜索落地页，被摘录、被判为作弊、被点进来一个空 h1，都是上线后才发现就晚了。
 * 所以把 issue 的验收标准直接写成测试：单 h1、有 BreadcrumbList 与 FAQPage、
 * 正文够长、llms.txt 收录、CTA 埋点属性在。
 */
describe("指南页", () => {
  const read = (page: string) => readFileSync(join(distDir, page), "utf8");

  it("每页只有一个 h1，且正文不少于 800 个汉字", () => {
    for (const page of GUIDES) {
      const html = read(page);
      const h1s = html.match(/<h1[\s>]/g) ?? [];
      expect(h1s.length, `${page} 的 h1 数量`).toBe(1);
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ");
      const hanzi = text.match(/[\u4e00-\u9fff]/g) ?? [];
      expect(hanzi.length, `${page} 的正文汉字数`).toBeGreaterThanOrEqual(800);
    }
  });

  it("结构化数据里有 BreadcrumbList 与 FAQPage", () => {
    for (const page of GUIDES) {
      const html = read(page);
      /** JSON-LD 里的类型名；支持单个实体、数组与 @graph 三种写法。 */
      const types = [
        ...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi),
      ].flatMap((match) => {
        const parsed = JSON.parse(match[1]) as
          | { "@type"?: string; "@graph"?: { "@type"?: string }[] }
          | { "@type"?: string }[];
        if (Array.isArray(parsed)) return parsed.map((item) => item["@type"]);
        const graph = parsed["@graph"] ?? [];
        return [parsed["@type"], ...graph.map((item) => item["@type"])];
      });
      expect(types, `${page} 缺 BreadcrumbList`).toContain("BreadcrumbList");
      expect(types, `${page} 缺 FAQPage`).toContain("FAQPage");
    }
  });

  it("寄样与对账两页带 HowTo", () => {
    for (const page of ["guides/sample-follow-up.html", "guides/textile-reconciliation.html"]) {
      expect(read(page), `${page} 缺 HowTo`).toContain('"@type":"HowTo"');
    }
  });

  it("本页目录里的锚点在页面里都存在", () => {
    for (const page of GUIDES) {
      const html = read(page);
      const toc = html.match(/<aside class="docs-toc">([\s\S]*?)<\/aside>/)?.[1] ?? "";
      const anchors = [...toc.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
      expect(anchors.length, `${page} 的目录是空的`).toBeGreaterThan(0);
      for (const id of anchors) {
        expect(html.includes(`id="${id}"`), `${page} 的目录指向不存在的 #${id}`).toBe(true);
      }
    }
  });

  it("CTA 带 data-cta，且 llms.txt 收录四篇", () => {
    const llms = readFileSync(join(distDir, "llms.txt"), "utf8");
    for (const page of GUIDES) {
      const html = read(page);
      expect(html, `${page} 缺 data-cta`).toMatch(/data-cta="(nav|hero|docs)"/);
      const slug = page.replace("guides/", "").replace(".html", "");
      expect(llms, `llms.txt 少了 ${slug}`).toContain(`/guides/${slug}.html`);
    }
  });
});
