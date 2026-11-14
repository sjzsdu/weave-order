import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/**
 * 帮助中心的 8 篇文章。
 *
 * 以前由 site/tools/build-docs.mjs 生成 HTML 并提交进仓库 ——
 * 改一篇文章要跑一次脚本、产出 8 个文件、还要人肉看 diff。
 * 现在文章就是 Markdown（MDX），改完即改，构建时渲染。
 */
const docs = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/docs" }),
  schema: z.object({
    /** 文章标题（正文大标题用同一个）。 */
    title: z.string(),
    /** 页面描述（SEO 用）。 */
    description: z.string(),
    /** 一句话导语。 */
    lede: z.string(),
    /** 站点内文件名，如 "signup.html"。
     *  不叫 slug：Astro 内容集合把 slug 当保留字段，会拿它覆盖路由。 */
    file: z.string(),
    /** 阅读顺序（上一篇 / 下一篇按它排）。 */
    order: z.number(),
    /** 本页目录：小节标题与锚点。 */
    sections: z.array(z.object({ id: z.string().optional(), heading: z.string() })).default([]),
  }),
});

export const collections = { docs };
