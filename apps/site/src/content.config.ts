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
 * 长尾搜索意图指南（/guides/*.html）。
 *
 * 与帮助中心的区别是目的：帮助中心回答「这个按钮在哪」，指南回答客户在搜索引擎里
 * 打的那句话（「纺织 ERP 怎么选」「寄样怎么跟进」）。所以指南要能被单独摘出来引用：
 * 一进来先给结论，正文里每个数字都能核对，结构化数据按 BreadcrumbList + FAQPage
 * （流程类加 HowTo）。
 *
 * 正文是 MDX，元信息（含 FAQ、HowTo 的结构化数据源）在 frontmatter：
 * FAQ 既渲染成可见的问答块，也生成 FAQPage，两者同源，不会出现「结构化数据里有、
 * 页面上没有」这种被搜索判为作弊的情况。
 */
const guides = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/guides" }),
  schema: z.object({
    /** 浏览器标题（含站点名）。 */
    title: z.string(),
    /** 页面描述（SEO 用）。 */
    description: z.string(),
    /** 正文大标题。与 title 不同：title 带站点名，h1 是给人看的那句话。 */
    h1: z.string(),
    /** 第一段直接回答标题的问题，可被单独摘出引用。 */
    lede: z.string(),
    /** 站内文件名，如 "sample-follow-up.html"。 */
    file: z.string(),
    /** 排序（侧栏顺序、上一篇 / 下一篇）。 */
    order: z.number(),
    /** 栏目词，显示在 eyebrow 里，如「选型」。 */
    kicker: z.string(),
    /** 短名，用于侧栏、上一篇 / 下一篇与 CTA 埋点的 label。 */
    navLabel: z.string(),
    /** 面包屑末项的长标题，如「纺织 ERP 选型指南」。 */
    crumb: z.string(),
    /** OG 描述（比 description 短）。 */
    ogDescription: z.string(),
    /** 页头右侧的三个数字，先给量化预期再展开正文。 */
    aside: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
    /** 本页目录：小节标题与锚点。 */
    sections: z
      .array(z.object({ id: z.string().optional(), heading: z.string(), toc: z.string().optional() }))
      .default([]),
    /** 正文末尾的行动区。 */
    cta: z.object({ title: z.string(), text: z.string() }),
    /** 常见问题：同时渲染成可见问答块与 FAQPage 结构化数据。 */
    faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
    /** 流程类指南的可复制步骤，生成 HowTo 结构化数据。 */
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
