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

/**
 * 指南：按搜索意图组织、可以被单独摘录的落地页（选型 / 报价 / 寄样 / 对账）。
 *
 * 和帮助文档的区别：FAQ 与 HowTo 放在 frontmatter，页面同时渲染可见问答与
 * JSON-LD —— 结构化数据必须有对应正文，两处不能各写一份。
 */
const guides = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/guides" }),
  schema: z.object({
    /** 浏览器标题（含站点名）。 */
    title: z.string(),
    /** 页面描述（SEO 用）。 */
    description: z.string(),
    /** 侧栏与上下篇里的短标题。 */
    navLabel: z.string(),
    /** 站内文件名，如 "sample-follow-up.html"（决定路由，不用 slug 字段）。 */
    file: z.string(),
    /** 顺序，决定侧栏与上下篇。 */
    order: z.number(),
    /** 页面标签，如「选型」「报价」。 */
    kicker: z.string(),
    /** 正文大标题：直接写成客户会搜的那个问题。 */
    h1: z.string(),
    /** 首屏第一段：先回答问题，再展开细节。 */
    answer: z.string(),
    /** 首屏右侧的三个要点。 */
    aside: z.array(z.object({ label: z.string(), text: z.string() })),
    /** 本页目录（正文里的 h2 要在 MDX 手写 id，与这里对应）。 */
    sections: z.array(z.object({ id: z.string(), heading: z.string(), toc: z.string().optional() })),
    /** 页尾 CTA 文案。 */
    cta: z.object({ title: z.string(), text: z.string() }),
    /** 可见 FAQ + FAQPage 结构化数据，两处共用这份数据。 */
    faq: z.array(z.object({ q: z.string(), a: z.string() })),
    /** 可选：流程型页面额外输出 HowTo。 */
    howTo: z
      .object({
        name: z.string(),
        description: z.string(),
        totalTime: z.string(),
        steps: z.array(z.object({ name: z.string(), text: z.string() })),
      })
      .optional(),
  }),
});

export const collections = { docs, guides };
