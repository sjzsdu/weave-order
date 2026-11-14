/**
 * 长尾落地页（指南）生成器：产物是静态 HTML，托管时不需要构建。
 *
 * 为什么要有它：四个指南页共享页头、页脚、侧栏目录、CTA 与结构化数据，
 * 手写四份必然走形，改一次 CTA 要改四处。这里把外壳定义一次，内容放在
 * site/tools/guides/*.mjs，只写正文与元信息。
 *
 *   node site/tools/build-guides.mjs
 *
 * 生成：site/guides/{textile-erp-selection,fabric-quotation-software,
 *                     sample-follow-up,textile-reconciliation}.html
 *
 * 新增一篇指南：在 site/tools/guides/ 加一个导出 default 的模块，再在下面
 * GUIDES 里登记；最后补 sitemap.xml 与 llms.txt。
 *
 * 站点地址取自 site/site.config.json，部署时由 tools/configure.mjs 改写。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "..");
const outDir = join(siteDir, "guides");
const SITE = JSON.parse(readFileSync(join(siteDir, "site.config.json"), "utf8")).site;

/* 站内搜索与访问统计的脚本由各自任务加入 assets/：文件存在才引用，
   避免在它们合入之前生成指向不存在文件的 <script>。 */
const OPTIONAL_SCRIPTS = ["analytics.config.js", "analytics.js", "search.js"];
const OPTIONAL_TAGS = OPTIONAL_SCRIPTS.filter((file) => existsSync(join(siteDir, "assets", file)))
  .map((file) => `<script src="../assets/${file}" defer></script>`)
  .join("\n");

/* 顺序即侧栏与上下篇顺序。 */
const GUIDES = [
  "textile-erp-selection.mjs",
  "fabric-quotation-software.mjs",
  "sample-follow-up.mjs",
  "textile-reconciliation.mjs",
];

/* 首页、价格、开通这些页面在站点根目录，指南在 guides/ 下，链接统一带 ../。 */
const NAV = {
  home: "../index.html",
  pricing: "../pricing.html",
  docs: "../docs/index.html",
  download: "../download.html",
  faq: "../index.html#faq",
  login: "../login.html",
  signup: "../signup.html",
};

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* JSON-LD 里的字符串要按 JSON 规则转义，不能用 HTML 实体。 */
function jsonEsc(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\s*\n\s*/g, " ");
}

function sidebar(current, pages) {
  const guideLinks = pages
    .map(
      (page) =>
        `            <li><a href="${page.slug}.html"${page.slug === current.slug ? ' aria-current="page"' : ""}>${page.navLabel}</a></li>`,
    )
    .join("\n");
  return `        <div class="docs-side__group">
          <h2>指南</h2>
          <ul>
${guideLinks}
          </ul>
        </div>
        <div class="docs-side__group">
          <h2>相关页面</h2>
          <ul>
            <li><a href="${NAV.home}#capabilities">能做什么</a></li>
            <li><a href="${NAV.pricing}">价格与套餐</a></li>
            <li><a href="${NAV.signup}">开通与试用</a></li>
            <li><a href="${NAV.docs}">帮助中心</a></li>
            <li><a href="${NAV.faq}">常见问题</a></li>
          </ul>
        </div>`;
}

function toc(sections) {
  return sections
    .filter((section) => section.id)
    .map((section) => `        <li><a href="#${section.id}">${section.toc || section.heading}</a></li>`)
    .join("\n");
}

/* FAQ 必须有可见正文，结构化数据（FAQPage）才有对应的页面内容。 */
function faqBlock(page) {
  const items = page.faq
    .map(
      (item, index) =>
        `        <details${index === 0 ? " open" : ""}>
          <summary>${item.q}</summary>
          <p>${item.a}</p>
        </details>`,
    )
    .join("\n");
  return `<h2 id="faq">常见问题</h2>
      <div class="faq">
${items}
      </div>`;
}

function pager(current, pages) {
  const index = pages.findIndex((page) => page.slug === current.slug);
  const prev = index > 0 ? pages[index - 1] : null;
  const next = index >= 0 && index < pages.length - 1 ? pages[index + 1] : null;
  return `      <div class="docs-pager">
        <a href="${prev ? prev.slug + ".html" : NAV.docs}"><small>${prev ? "上一篇" : "回到"}</small><span>${prev ? prev.navLabel : "帮助中心"}</span></a>
        <a href="${next ? next.slug + ".html" : NAV.pricing}"><small>${next ? "下一篇" : "下一步"}</small><span>${next ? next.navLabel : "价格与套餐"}</span></a>
      </div>`;
}

function breadcrumbLd(page) {
  return `{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "首页", "item": "${SITE}/" },
    { "@type": "ListItem", "position": 2, "name": "帮助中心", "item": "${SITE}/docs/" },
    { "@type": "ListItem", "position": 3, "name": "${jsonEsc(page.crumb)}", "item": "${SITE}/guides/${page.slug}.html" }
  ]
}`;
}

function faqLd(page) {
  const items = page.faq
    .map(
      (item) => `    {
      "@type": "Question",
      "name": "${jsonEsc(item.q)}",
      "acceptedAnswer": { "@type": "Answer", "text": "${jsonEsc(item.a)}" }
    }`,
    )
    .join(",\n");
  return `{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
${items}
  ]
}`;
}

function howToLd(page) {
  if (!page.howTo) return null;
  const steps = page.howTo.steps
    .map(
      (step, index) => `    {
      "@type": "HowToStep",
      "position": ${index + 1},
      "name": "${jsonEsc(step.name)}",
      "text": "${jsonEsc(step.text)}"
    }`,
    )
    .join(",\n");
  return `{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "${jsonEsc(page.howTo.name)}",
  "description": "${jsonEsc(page.howTo.description)}",
  "totalTime": "${page.howTo.totalTime}",
  "step": [
${steps}
  ]
}`;
}

function render(page, pages) {
  const url = `${SITE}/guides/${page.slug}.html`;
  const body = page.sections
    .map((section) => {
      const heading = section.id
        ? `<h2 id="${section.id}">${section.heading}</h2>`
        : `<h2>${section.heading}</h2>`;
      return `${heading}
${section.html.trim()}`;
    })
    .join("\n\n      ");

  const aside = page.aside
    .map(([key, value]) => `          <p><b>${key}</b>${value}</p>`)
    .join("\n");

  const tocItems =
    toc(page.sections) + `\n        <li><a href="#faq">常见问题</a></li>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(page.titleTag)}</title>
<meta name="description" content="${esc(page.description)}" />
<meta name="theme-color" content="#F7F4EE" />
<link rel="icon" href="../assets/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="../assets/icons/icon-32.png" sizes="32x32" type="image/png" />
<link rel="apple-touch-icon" href="../assets/icons/icon-180.png" />
<link rel="canonical" href="${url}" />

<meta property="og:type" content="article" />
<meta property="og:site_name" content="织序 WeaveOrder" />
<meta property="og:title" content="${esc(page.titleTag)}" />
<meta property="og:description" content="${esc(page.ogDescription)}" />
<meta property="og:image" content="${SITE}/assets/og-cover.png" />
<meta property="og:locale" content="zh_CN" />
<meta property="og:url" content="${url}" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="alternate" type="text/plain" href="../llms.txt" title="给 AI 助手的产品摘要" />
<link rel="stylesheet" href="../assets/styles.css" />
<link rel="stylesheet" href="../assets/pages.css" />
<script>document.documentElement.classList.add("js");</script>
<script type="application/ld+json">
${breadcrumbLd(page)}
</script>
<script type="application/ld+json">
${faqLd(page)}
</script>${page.howTo ? `\n<script type="application/ld+json">\n${howToLd(page)}\n</script>` : ""}
</head>
<body>
<a class="skip-link" href="#main">跳到主要内容</a>

<header class="site-header" id="siteHeader">
  <div class="container">
    <nav class="nav" aria-label="主导航">
      <a class="nav__brand" href="${NAV.home}" aria-label="织序 WeaveOrder 首页">
        <img src="../assets/logo-mark.svg" alt="" width="34" height="34" />
        <span>
          <span class="nav__brand-name">织序</span>
          <span class="nav__brand-sub">WEAVE ORDER</span>
        </span>
      </a>
      <div class="nav__links" id="navLinks">
        <a href="${NAV.home}#capabilities">能做什么</a>
        <a href="${NAV.pricing}">价格</a>
        <a href="${NAV.docs}">帮助文档</a>
        <a href="${NAV.download}">下载</a>
        <a href="${NAV.faq}">常见问题</a>
      </div>
      <div class="nav__actions">
        <a class="btn btn--ghost btn--sm" href="${NAV.login}">登录</a>
        <a class="btn btn--primary btn--sm" href="${NAV.signup}" data-cta="nav" data-cta-label="指南 · ${esc(page.navLabel)}">免费试用</a>
        <button class="nav__toggle" id="navToggle" aria-label="打开菜单" aria-expanded="false" aria-controls="navLinks">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" stroke-linecap="round"/></svg>
        </button>
      </div>
    </nav>
  </div>
</header>

<main id="main">
  <section class="page-hero">
    <div class="container">
      <div class="page-hero__inner">
        <div>
          <p class="eyebrow">指南 · ${esc(page.kicker)}</p>
          <h1>${page.h1}</h1>
          <p class="lede">${page.answer}</p>
          <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:24px">
            <a class="btn btn--primary" href="${NAV.signup}" data-cta="hero" data-cta-label="指南 · ${esc(page.navLabel)}">免费创建公司</a>
            <a class="btn btn--ghost" href="${NAV.pricing}" data-cta="hero" data-cta-label="指南 · 看价格">看价格</a>
          </div>
        </div>
        <div class="page-hero__aside">
${aside}
        </div>
      </div>
    </div>
  </section>

  <div class="container docs-shell docs-shell--guide">
    <aside class="docs-side">
      <nav aria-label="指南目录">
${sidebar(page, pages)}
      </nav>
    </aside>

    <div class="docs-main">
      <div class="docs-crumbs"><a href="${NAV.home}">首页</a><span>/</span><a href="${NAV.docs}">帮助中心</a><span>/</span><span>${esc(page.crumb)}</span></div>
      ${body}

      ${faqBlock(page)}

      <div class="note-box" style="margin:44px 0 8px;padding:22px 24px">
        <p style="margin:0 0 6px;font-family:var(--font-serif);font-size:18px;font-weight:700;color:var(--ink-900)">${page.ctaTitle}</p>
        <p style="margin:0 0 16px">${page.ctaText}</p>
        <div style="display:flex;flex-wrap:wrap;gap:10px">
          <a class="btn btn--primary" href="${NAV.signup}" data-cta="docs" data-cta-label="指南 · ${esc(page.navLabel)}">免费创建公司</a>
          <a class="btn btn--ghost" href="${NAV.pricing}" data-cta="docs" data-cta-label="指南 · 看价格与套餐">看价格与套餐</a>
        </div>
      </div>

${pager(page, pages)}
    </div>

    <aside class="docs-toc">
      <h2>本页目录</h2>
      <ul>
${tocItems}
      </ul>
    </aside>
  </div>
</main>

<footer class="site-footer">
  <div class="container">
    <div class="footer__grid">
      <div>
        <div class="footer__brand">
          <img src="../assets/logo-mark.svg" alt="" width="36" height="36" />
          <span>织序 WeaveOrder</span>
        </div>
        <p>纺织贸易的智能体原生操作系统。找样、报价、寄样、跟单、对账由智能体完成，人只负责审批结果。</p>
        <span class="footer__badge"><i></i>服务运行正常</span>
      </div>
      <div>
        <h4>产品</h4>
        <ul>
          <li><a href="${NAV.home}#capabilities">能做什么</a></li>
          <li><a href="${NAV.home}#how">一句话跑一单</a></li>
          <li><a href="${NAV.pricing}">价格</a></li>
          <li><a href="${NAV.download}">下载</a></li>
        </ul>
      </div>
      <div>
        <h4>资源</h4>
        <ul>
          <li><a href="${NAV.docs}">帮助文档</a></li>
          <li><a href="${NAV.docs}#guides">选型与实操指南</a></li>
          <li><a href="${NAV.home}#faq">常见问题</a></li>
          <li><a href="../llms.txt">给 AI 助手的摘要</a></li>
        </ul>
      </div>
      <div>
        <h4>公司</h4>
        <ul>
          <li><a href="${NAV.signup}">联系与开通</a></li>
          <li><a href="${NAV.login}">登录入口</a></li>
          <li><a href="mailto:hello@weaveorder.cn">hello@weaveorder.cn</a></li>
          <li><a href="https://github.com/sjzsdu/weave-order">GitHub</a></li>
        </ul>
      </div>
    </div>
    <div class="footer__bottom">
      <span>© 2026 织序 WeaveOrder · 纺织贸易的智能体原生操作系统</span>
      <span>你说生意，系统做单。</span>
    </div>
  </div>
</footer>

<script src="../assets/main.js" defer></script>
<script src="../assets/pages.js" defer></script>${OPTIONAL_TAGS ? "\n" + OPTIONAL_TAGS : ""}
</body>
</html>
`;
}

const pages = [];
for (const file of GUIDES) {
  const mod = await import(pathToFileURL(join(here, "guides", file)).href);
  pages.push(mod.default);
}

mkdirSync(outDir, { recursive: true });
for (const page of pages) {
  const out = join(outDir, `${page.slug}.html`);
  writeFileSync(out, render(page, pages), "utf8");
  console.log("wrote " + out);
}
