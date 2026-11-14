import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";
import xmlSitemap from "./src/integrations/xml-sitemap.ts";

const siteConfig = JSON.parse(
  readFileSync(new URL("./src/site.config.json", import.meta.url), "utf8"),
);

export default defineConfig({
  // 站点基址：canonical、OG、sitemap 都用它。默认写死 weaveorder.cn，
  // 部署环境用 WEAVE_SITE_URL 等变量在容器启动时改写（见 apps/site/docker/entrypoint.sh）。
  site: siteConfig.site,
  trailingSlash: "never",
  build: {
    // 输出 xxx.html：与迁移前完全一致的地址（/pricing.html、/docs/import.html）。
    // 换框架不换地址——URL 一变就是换站，搜索权重会掉。
    format: "file",
  },
  integrations: [mdx(), xmlSitemap(siteConfig)],
  vite: {
    plugins: [tailwindcss()],
  },
});
