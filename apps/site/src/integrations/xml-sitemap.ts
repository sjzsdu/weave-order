import { writeFile } from "node:fs/promises";
import type { AstroIntegration } from "astro";

/**
 * 生成 sitemap.xml。
 *
 * 为什么不用 @astrojs/sitemap：它按路由形式输出（/pricing），
 * 而这个站的地址一直是 /pricing.html（迁移前就是 .html 结尾）。
 * URL 一变就是换地址，搜索权重会掉，所以这里显式列出与旧站一致的地址表。
 *
 * 地址表来自迁移前的 site/sitemap.xml，一条不多一条不少；新增页面要在这里补一条
 * ——这一份是手写清单，不做目录扫描：扫描会把 404 与草稿也收进去。
 */
interface SitemapEntry {
  /** 站内路径（根路径写 "/"）。 */
  path: string;
  changefreq: string;
  priority: string;
}

/** 站点配置里跟 sitemap 有关的字段。 */
interface SitemapSiteConfig {
  /** 站点基址，canonical 与 sitemap 共用。 */
  site: string;
}

const ENTRIES: SitemapEntry[] = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
  { path: "/pricing.html", changefreq: "monthly", priority: "0.9" },
  { path: "/download.html", changefreq: "monthly", priority: "0.8" },
  { path: "/signup.html", changefreq: "monthly", priority: "0.9" },
  { path: "/login.html", changefreq: "yearly", priority: "0.6" },
  { path: "/legal.html", changefreq: "yearly", priority: "0.4" },
  { path: "/docs/", changefreq: "weekly", priority: "0.8" },
  { path: "/docs/quickstart.html", changefreq: "monthly", priority: "0.7" },
  { path: "/docs/signup.html", changefreq: "monthly", priority: "0.6" },
  { path: "/docs/import.html", changefreq: "monthly", priority: "0.6" },
  { path: "/docs/approvals.html", changefreq: "monthly", priority: "0.6" },
  { path: "/docs/quotes.html", changefreq: "monthly", priority: "0.6" },
  { path: "/docs/printing.html", changefreq: "monthly", priority: "0.6" },
  { path: "/docs/agent.html", changefreq: "monthly", priority: "0.5" },
  { path: "/docs/security.html", changefreq: "monthly", priority: "0.6" },
  { path: "/docs/faq.html", changefreq: "monthly", priority: "0.7" },
  // 长尾搜索意图指南：四页各回答一个客户会搜的问题，priority 高于帮助中心单篇。
  { path: "/guides/textile-erp-selection.html", changefreq: "monthly", priority: "0.8" },
  { path: "/guides/fabric-quotation-software.html", changefreq: "monthly", priority: "0.8" },
  { path: "/guides/sample-follow-up.html", changefreq: "monthly", priority: "0.8" },
  { path: "/guides/textile-reconciliation.html", changefreq: "monthly", priority: "0.8" },
];

export default function xmlSitemap(siteConfig: SitemapSiteConfig): AstroIntegration {
  return {
    name: "weave-xml-sitemap",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const lastmod = new Date().toISOString().slice(0, 10);
        const body = ENTRIES.map((entry) =>
          [
            "  <url>",
            `    <loc>${siteConfig.site}${entry.path}</loc>`,
            `    <lastmod>${lastmod}</lastmod>`,
            `    <changefreq>${entry.changefreq}</changefreq>`,
            `    <priority>${entry.priority}</priority>`,
            "  </url>",
          ].join("\n"),
        ).join("\n");

        const xml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          body,
          "</urlset>",
          "",
        ].join("\n");

        await writeFile(new URL("./sitemap.xml", dir), xml, "utf8");
        logger.info(`已生成 sitemap.xml（${ENTRIES.length} 条地址）`);
      },
    },
  };
}
