/**
 * 帮助中心文章页生成器（仅开发期使用，产物是静态 HTML）。
 *
 * 为什么要有它：帮助中心每篇文章共享同一套页头、侧栏、页脚、目录、
 * 上下篇与结构化数据。手写六份必然走形，改动一次要改六处。
 * 这里把「外壳」定义一次，文章只写正文。
 *
 *   node site/tools/build-docs.mjs
 *
 * 生成结果直接提交到仓库，托管时不需要 Node，也不需要构建步骤。
 * 首页（docs/index.html）与 5 分钟上手（docs/quickstart.html）含定制交互，
 * 由手工维护，不在此脚本内。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "docs");
// 站点地址取自 site/site.config.json，部署时由 tools/configure.mjs 改写；
// 生成器跟着读同一份配置，重新生成文档不会把域名重置回占位值。
const SITE = JSON.parse(readFileSync(join(here, "..", "site.config.json"), "utf8")).site;

/* 站内搜索与访问统计的脚本由各自任务加入 assets/：文件存在才引用，
   避免重新生成文档时把它们从页面里抹掉，也避免引用不存在的文件。 */
const OPTIONAL_SCRIPTS = ["analytics.config.js", "analytics.js", "search.js"];
const OPTIONAL_TAGS = OPTIONAL_SCRIPTS.filter((file) => existsSync(join(here, "..", "assets", file)))
  .map((file) => `<script src="../assets/${file}" defer></script>`)
  .join("\n");

const NAV = {
  home: "../index.html",
  pricing: "../pricing.html",
  docs: "index.html",
  download: "../download.html",
  faq: "../index.html#faq",
  login: "../login.html",
  signup: "../signup.html",
};

const SIDE = [
  {
    title: "开始使用",
    items: [
      ["index.html", "帮助中心"],
      ["quickstart.html", "5 分钟上手"],
      ["signup.html", "开通、试用与付费"],
    ],
  },
  {
    title: "日常操作",
    items: [
      ["import.html", "导入客户与样品"],
      ["approvals.html", "审批与权限"],
      ["quotes.html", "报价与客户查看"],
      ["printing.html", "打印与单证"],
      ["agent.html", "智能体与命令行"],
    ],
  },
  {
    title: "其他",
    items: [
      ["security.html", "数据与安全"],
      ["faq.html", "常见问题"],
    ],
  },
  {
    title: "指南",
    items: [
      ["../guides/textile-erp-selection.html", "纺织 ERP 怎么选"],
      ["../guides/fabric-quotation-software.html", "面料报价软件"],
      ["../guides/sample-follow-up.html", "寄样跟进 SOP"],
      ["../guides/textile-reconciliation.html", "纺织对账与回款"],
    ],
  },
];

const ORDER = [
  "quickstart.html",
  "signup.html",
  "import.html",
  "approvals.html",
  "quotes.html",
  "printing.html",
  "agent.html",
  "security.html",
  "faq.html",
];

function sidebar(current) {
  return SIDE.map(
    (group) => `        <div class="docs-side__group">
          <h2>${group.title}</h2>
          <ul>
${group.items
  .map(
    ([href, label]) =>
      `            <li><a href="${href}"${href === current ? ' aria-current="page"' : ""}>${label}</a></li>`,
  )
  .join("\n")}
          </ul>
        </div>`,
  ).join("\n");
}

function toc(sections) {
  return sections
    .filter((s) => s.id)
    .map((s) => `        <li><a href="#${s.id}">${s.toc || s.heading}</a></li>`)
    .join("\n");
}

function pager(slug) {
  const index = ORDER.indexOf(slug);
  const prev = index > 0 ? ORDER[index - 1] : "index.html";
  const next = index >= 0 && index < ORDER.length - 1 ? ORDER[index + 1] : "index.html";
  const titles = {
    "index.html": "帮助中心",
    "quickstart.html": "5 分钟上手",
    "signup.html": "开通、试用与付费",
    "import.html": "导入客户与样品",
    "approvals.html": "审批与权限",
    "quotes.html": "报价与客户查看",
    "printing.html": "打印与单证",
    "agent.html": "智能体与命令行",
    "security.html": "数据与安全",
    "faq.html": "常见问题",
  };
  return `      <div class="docs-pager">
        <a href="${prev}"><small>上一篇</small><span>${titles[prev] ?? ""}</span></a>
        <a href="${next}"><small>下一篇</small><span>${titles[next] ?? ""}</span></a>
      </div>`;
}

function crumbs(title, slug) {
  const url = slug === "index.html" ? `${SITE}/docs/` : `${SITE}/docs/${slug}`;
  return `      <div class="docs-crumbs"><a href="../index.html">首页</a><span>/</span><a href="index.html">帮助中心</a><span>/</span><span>${title}</span></div>
      <script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "首页", "item": "${SITE}/" },
    { "@type": "ListItem", "position": 2, "name": "帮助中心", "item": "${SITE}/docs/" },
    { "@type": "ListItem", "position": 3, "name": "${title}", "item": "${url}" }
  ]
}
</script>`;
}

function render(page) {
  const { slug, title, description, lede, sections, extraJsonLd } = page;
  const url = slug === "index.html" ? `${SITE}/docs/` : `${SITE}/docs/${slug}`;
  const body = sections
    .map((s) => {
      const heading = s.id ? `<h2 id="${s.id}">${s.heading}</h2>` : `<h2>${s.heading}</h2>`;
      return `${heading}
${s.html.trim()}`;
    })
    .join("\n\n      ");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · 织序帮助中心</title>
<meta name="description" content="${description}" />
<meta name="theme-color" content="#F7F4EE" />
<link rel="icon" href="../assets/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="../assets/icons/icon-32.png" sizes="32x32" type="image/png" />
<link rel="apple-touch-icon" href="../assets/icons/icon-180.png" />
<link rel="canonical" href="${url}" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="织序 WeaveOrder" />
<meta property="og:title" content="${title} · 织序帮助中心" />
<meta property="og:description" content="${description}" />
<meta property="og:image" content="${SITE}/assets/og-cover.png" />
<meta property="og:locale" content="zh_CN" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="alternate" type="text/plain" href="../llms.txt" title="给 AI 助手的产品摘要" />
<link rel="stylesheet" href="../assets/styles.css" />
<link rel="stylesheet" href="../assets/pages.css" />
<script>document.documentElement.classList.add("js");</script>
${extraJsonLd ? extraJsonLd + "\n" : ""}</head>
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
        <a href="${NAV.docs}" aria-current="true">帮助文档</a>
        <a href="${NAV.download}">下载</a>
        <a href="${NAV.faq}">常见问题</a>
      </div>
      <div class="nav__actions">
        <a class="btn btn--ghost btn--sm" href="${NAV.login}">登录</a>
        <a class="btn btn--primary btn--sm" href="${NAV.signup}">免费试用</a>
        <button class="nav__toggle" id="navToggle" aria-label="打开菜单" aria-expanded="false" aria-controls="navLinks">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" stroke-linecap="round"/></svg>
        </button>
      </div>
    </nav>
  </div>
</header>

<main id="main">
  <div class="container docs-shell">
    <aside class="docs-side">
      <nav aria-label="帮助文档目录">
${sidebar(slug)}
      </nav>
    </aside>

    <div class="docs-main">
${crumbs(title, slug)}
      <h1 id="top">${title}</h1>
      <p class="docs-lede">${lede}</p>

      ${body}

${pager(slug)}
    </div>

    <aside class="docs-toc">
      <h2>本页目录</h2>
      <ul>
${toc(sections)}
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
          <li><a href="../index.html#capabilities">能做什么</a></li>
          <li><a href="../index.html#how">一句话跑一单</a></li>
          <li><a href="../pricing.html">价格</a></li>
          <li><a href="../download.html">下载</a></li>
        </ul>
      </div>
      <div>
        <h4>资源</h4>
        <ul>
          <li><a href="index.html">帮助文档</a></li>
          <li><a href="index.html#guides">选型与实操指南</a></li>
          <li><a href="quickstart.html">5 分钟上手</a></li>
          <li><a href="faq.html">常见问题</a></li>
          <li><a href="../llms.txt">给 AI 助手的摘要</a></li>
        </ul>
      </div>
      <div>
        <h4>公司</h4>
        <ul>
          <li><a href="../signup.html">联系与开通</a></li>
          <li><a href="../login.html">登录入口</a></li>
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

/* ======================================================================== */
/* 文章内容                                                                  */
/* ======================================================================== */

const pages = [
  {
    slug: "signup.html",
    title: "开通、试用与付费",
    description:
      "织序的开通流程、3 天试用规则、套餐与 credits、试用到付费的转换、账单与发票。价格与合同一次说清。",
    lede: "这一页回答「钱和账号」相关的问题：试用期怎么算、什么时候开始付费、发票怎么开、加人怎么算钱。业务怎么用不在这里，看 5 分钟上手。",
    sections: [
      {
        id: "link",
        heading: "开通：自己创建，或接受邀请",
        html: `
        <p>开通分两种人，各走一条路：</p>
        <h3>老板：自己创建公司</h3>
        <ol>
          <li><strong>登录</strong>：用邮箱或手机号收验证码登录（统一账号，公司里所有人共用这一套）。</li>
          <li><strong>创建</strong>：点「创建公司」，填公司名（标识可选），几秒建好。你就是老板账号，3 天试用从此刻开始。</li>
          <li><strong>开始用</strong>：导入客户与样品，派第一件活。</li>
        </ol>
        <h3>员工：接受老板的邀请</h3>
        <ol>
          <li>老板在「组织与设置 → 邀请同事」填你的邮箱和角色，生成一条 7 天有效的专属链接，复制到微信或邮件发给你。</li>
          <li>你打开链接、登录，页面会显示「加入哪家公司、什么角色」。点「接受邀请」即成为成员。</li>
          <li>你能看到的客户范围由邀请时的角色决定（销售只看自己的客户，主管看本组，财务只读单据）。</li>
        </ol>
        <div class="docs-callout">
          <b>链接会核对邮箱。</b> 邀请只认被邀请的那个邮箱；转发给别人打不开，超过 7 天找老板重发。同一条链接点两次不会重复加入。一个账号目前只能属于一间公司，换公司需要我们先把你从原公司移出。
        </div>`,
      },
      {
        id: "trial",
        heading: "3 天试用怎么算",
        html: `
        <p>从创建公司那一刻起 3 个自然日，全功能，不需要填银行卡。到期前 1 天会提醒你一次；到期不会自动扣费，也不会自动转成付费。</p>
        <p>到期当天系统自动把账号转成只读（能看到、能导出，不能派新活、不能发报价），不需要人工操作；补费或联系我们转正后立刻恢复写入。</p>
        <ul>
          <li><strong>到期后第 1 天到第 30 天</strong>：只读。能看、能导出，不能派新活、不能发报价。</li>
          <li><strong>第 31 天到第 120 天</strong>：休眠。数据保留，联系我们随时恢复。</li>
          <li><strong>超过 120 天</strong>：按合同约定的保留期处理，删除前会再通知你一次。</li>
        </ul>`,
      },
      {
        id: "activate",
        heading: "从试用转成正式付费",
        html: `
        <p>试用期内随时可以转正。流程是三步，通常当天完成：</p>
        <ol>
          <li>告诉我们对公抬头、套餐（基础 / 专业 / 企业）和账期（月付或年付）。</li>
          <li>我们发合同与付款信息，你盖章回传、安排付款。</li>
          <li>收到款项后我们把账号转正，试用期的数据、权限、审计记录全部保留，不用重新导入。</li>
        </ol>
        <div class="docs-callout">
          <b>试用期数据不会因为转正丢失。</b> 客户、样品、历史报价、审批记录都在原来的公司空间里，转正只是改订阅状态，不搬迁数据。
        </div>`,
      },
      {
        id: "billing",
        heading: "账单与发票",
        toc: "账单与发票",
        html: `
        <p>从「组织与设置 → 账单」可以看到每一期的应付金额、已付记录和发票状态。开票信息也在这里填：</p>
        <ol>
          <li>填公司全称、纳税人识别号、开户行与账号、注册地址与电话。</li>
          <li>选择发票类型：增值税普通发票或专用发票。</li>
          <li>填收票邮箱。付款后 3 个工作日内开出电子发票，发到这个邮箱。</li>
        </ol>
        <p>发票金额和账单金额一致，不拆单、不重复开。需要红冲或换开时，直接写信到 <a href="mailto:hello@weaveorder.cn">hello@weaveorder.cn</a>，说明原发票号和新抬头。</p>
        <p>账单里的每一行都能点开：这一期是哪个套餐、从哪天算到哪天、有没有按天折算。看不懂某一行，把那一行的截图发给我们即可。</p>`,
      },
      {
        id: "seats",
        heading: "套餐、账号数与 credits",
        html: `
        <p>我们按公司订阅，不按人头：套餐里有固定账号数和每月 credits，只要不超，人数随便加。</p>
        <div class="table-wrap">
          <table class="price-table">
            <thead><tr><th>套餐</th><th>月费</th><th>含账号</th><th>含 credits / 月</th></tr></thead>
            <tbody>
              <tr><td>基础</td><td>¥299</td><td>5 个</td><td>20,000</td></tr>
              <tr><td>专业</td><td>¥899</td><td>20 个</td><td>100,000</td></tr>
              <tr><td>企业</td><td>¥2,999 起</td><td>50 个起</td><td>500,000 起</td></tr>
            </tbody>
          </table>
        </div>
        <p><strong>1 credit = 1,000 tokens</strong>（输入 + 输出），一次报价大约 5 到 15 credits。额度每月 1 日重置，不结转。</p>
        <ul>
          <li><strong>加账号</strong>：套餐没满就直接加人，不额外收费；满了升级套餐。</li>
          <li><strong>升级套餐</strong>：即时生效，按剩余天数折算，账号数与 credits 立刻按新套餐算。</li>
          <li><strong>降级</strong>：下一个账期生效；超出新套餐的账号会被停用，数据保留。</li>
          <li><strong>加油包</strong>：¥99 / 10,000 credits，找对接人充值；当月有效，不自动购买。</li>
        </ul>
        <p>只有公司管理员能改套餐；找不到按钮说明你的角色没有账单权限，找老板即可。</p>`,
      },
      {
        id: "what-counts",
        heading: "什么算一次智能体动作",
        html: `
        <p>一次找样、一次核价、一次寄样跟进、一次对账核算，各算一次。你自己在界面上翻页、看数字、改一处，都不算。</p>
        <div class="docs-figure">
          <b>举例：</b>客户问「32S 汗布 3.2 吨」→ 智能体找 3 个候选样品（1 次）+ 核价（1 次）+ 起草报价（1 次）= 3 次动作。你把它驳回，再让它重算一次 = 再 1 次。
        </div>
        <p>额度用到 80% 会在工作台提醒；用尽后当月停止自动执行，你仍然可以手动派活并看到草稿，但智能体不再自己往下跑。额度不会自动超支扣费。</p>`,
      },
      {
        id: "support",
        heading: "账单有疑问找谁",
        html: `
        <p>写信到 <a href="mailto:hello@weaveorder.cn">hello@weaveorder.cn</a>，标题写「账单 + 公司名」，正文附账单期号或截图。工作日 4 小时内回复，涉及发票重开的当天处理。</p>
        <p>合同、招投标材料、信息安全问卷等需要盖章文件的，也在同一邮箱说一声，我们会把模板发给你。</p>`,
      },
    ],
  },

  {
    slug: "import.html",
    title: "导入客户与样品",
    description:
      "把现有 Excel / CSV 客户表与样品表导入织序：需要哪些列、列名对不上怎么办、常见报错怎么修、导入之后检查什么。",
    lede: "第一次上手最费时间的就是这一步。好消息是不用改你的 Excel 结构：只要有一列能认出客户名或样品编号，剩下的列可以在预览页手动对应。",
    sections: [
      {
        id: "prepare",
        heading: "先做一件事：一张表只放一类数据",
        html: `
        <p>客户和样品分两个文件导入，不要混在一张表里。每个文件第一行是列名，从第二行开始是数据，不要合并单元格，不要有合计行。</p>
        <pre><code>客户表：客户名称 | 联系人 | 手机 | 地址 | 信用额度
样品表：样品编号 | 名称 | 成分 | 克重 | 门幅 | 成本价 | 库存</code></pre>
        <p>担心格式不对？导入页可以下载两个模板（客户模板、样品模板），把你的数据复制进对应列即可。</p>`,
      },
      {
        id: "customer",
        heading: "客户表：至少要有什么",
        html: `
        <p><strong>必填只有一项：客户名称。</strong> 其余都能后补，后补也不影响已经产生的报价。</p>
        <ul>
          <li><strong>客户名称</strong>：同一客户在不同表里写法不一致时，先在 Excel 里统一，否则会被当成两个客户。</li>
          <li><strong>联系人 / 手机 / 微信</strong>：用于寄样跟进时找人，也用于报价页的称呼。</li>
          <li><strong>信用额度 / 账期</strong>：填了之后，报价页会显示账期，对账时用于判断逾期。</li>
          <li><strong>归属业务员</strong>：填手机号或姓名，系统会在预览页让你确认对应到哪个同事；不填则默认归导入人。</li>
        </ul>`,
      },
      {
        id: "sample",
        heading: "样品表：决定报价准不准",
        html: `
        <p>样品表的完整度直接决定报价草稿的质量。最少要有编号、名称、成本价；有成分、克重、门幅，找样命中率会高很多。</p>
        <ul>
          <li><strong>样品编号</strong>：公司内部唯一的编号，用于报价单和打印单据上追溯。重复编号会被合并，保留成本价最新的一条。</li>
          <li><strong>成本价</strong>：按米或按公斤填写都可以，导入时选择单位。不填成本价的样品，报价时无法判断毛利底线，智能体会提示你补。</li>
          <li><strong>库存</strong>：填了之后，报价页会显示「可供」，避免报出没货的规格。</li>
          <li><strong>图片</strong>：Excel 里嵌入的图片不会导入；如果需要以图找样，在样品详情页单独上传，或用手机拍一张。</li>
        </ul>`,
      },
      {
        id: "mapping",
        heading: "列名对不上怎么办",
        html: `
        <p>预览页会把你的列名和系统字段并排列出来，识别不准的直接在下拉里改。这一步不会写入任何数据，可以反复调整。</p>
        <ul>
          <li>表头不在第一行？在预览页选择「表头所在行」。</li>
          <li>一列里同时有「元」和数字？把该列类型指定为「文本」，导入后再统一清洗；或者先在 Excel 里替换掉单位。</li>
          <li>一个客户对应多个联系人？先导入主联系人，其余的在客户详情里补。</li>
        </ul>`,
      },
      {
        id: "errors",
        heading: "常见报错与修法",
        html: `
        <p>导入是原子操作：<strong>只要有一行不合格，整批都不入库</strong>。报错会告诉你是第几行、哪一列、为什么，改完重传即可。</p>
        <div class="docs-figure">
          <b>第 37 行 · 成本价不是有效数字</b><br />
          原因：单元格里是「¥23.50 / 米」或空字符串。<br />
          修法：改成 <code>23.5</code>，或在预览页把这一列指定为文本后手工修正。
        </div>
        <ul>
          <li><strong>客户名称不能为空</strong>：有合并单元格或空行导致名称落在上一行。</li>
          <li><strong>样品编号重复</strong>：同一个文件里出现两次，删掉旧的那行。</li>
          <li><strong>日期不是有效日期</strong>：Excel 里存成了文本，改成日期格式或统一成 <code>2026-03-01</code>。</li>
          <li><strong>文件超过 20 MB</strong>：拆成两个文件，或删掉用不到的列与图片。</li>
        </ul>`,
      },
      {
        id: "after",
        heading: "导入之后，检查这三件事",
        html: `
        <ol>
          <li>客户总数和样品总数是否和 Excel 行数对得上（去重后）。</li>
          <li>随便点开三个客户，看联系人、手机、业务员归属对不对。</li>
          <li>点开一个样品，确认成本价与单位正确，因为这直接决定报价毛利。</li>
        </ol>
        <p>对不上时不要急着手工改，先在导入记录里看这一批的明细，绝大多数是列对应错了，重新导入一次比逐条改快。</p>`,
      },
      {
        id: "repeat",
        heading: "重复导入会怎样",
        html: `
        <p>客户按名称去重，样品按编号去重。重复导入同一份文件不会产生重复记录，只会更新已存在记录里的空字段与成本价。</p>
        <p>历史报价不会因为更新样品成本价而改变：报价一旦批准，金额就固定，改成本只影响之后的新报价。这是审计要求，不是限制。</p>`,
      },
    ],
  },

  {
    slug: "approvals.html",
    title: "审批与权限",
    description:
      "一张审批卡怎么读、三个动作怎么选、谁能批多少钱、角色与数据范围、邀请同事与离职交接。",
    lede: "织序里人要做的只有一件事：看草稿、做决定。这一页把「这张卡能不能点批准」「他为什么看不到这个客户」讲清楚。",
    sections: [
      {
        id: "anatomy",
        heading: "一张审批卡怎么读",
        html: `
        <p>所有草稿长得一样，从上到下四块：</p>
        <ol>
          <li><strong>谁、要什么</strong>：客户名、品名、客户原话。原话保留原文，不做改写，方便你判断语气。</li>
          <li><strong>金额与改动</strong>：数量、单价、总价，以及相对上一次给这个客户的报价改了多少。</li>
          <li><strong>依据</strong>：用了哪个样品、哪条历史报价、成本底线、毛利。每个标签可点开。</li>
          <li><strong>决定</strong>：批准并发送、改一处、驳回。</li>
        </ol>
        <p>卡上不会出现没有出处的数字。如果一个金额旁边没有依据标签，说明是人工填的，不是智能体算的。</p>`,
      },
      {
        id: "decide",
        heading: "三个动作分别会发生什么",
        html: `
        <ul>
          <li><strong>批准并发送</strong>：报价立即生效，生成客户查看链接，写一条审计记录，并把后续跟进排进计划。</li>
          <li><strong>改一处</strong>：改金额或写一句话，金额由系统按「分」重算，不会出现小数误差。改幅超限会自动升级。</li>
          <li><strong>驳回</strong>：草稿作废并留痕，写明驳回原因。同样的需求再来时，智能体会参考你的驳回理由。</li>
        </ul>
        <div class="docs-callout">
          <b>只有人能批准。</b> 智能体自己不能把草稿变成正式报价，也不能改账。这是产品规则，不是可以打开的开关。
        </div>`,
      },
      {
        id: "limits",
        heading: "谁能批多少钱",
        html: `
        <p>每个角色有一个审批金额上限。超过上限时，卡片上不会出现「批准」按钮，而是显示「已升级给 XXX」，审批自动往上走一层。</p>
        <ul>
          <li><strong>改幅超过 5% 或金额超过 1 万元</strong>：自动升级主管，不需要你手动报备。</li>
          <li><strong>低于成本底线</strong>：直接拦下，只能驳回或改到线以上。</li>
          <li><strong>一直没人批</strong>：超过 4 小时提醒一次，超过 24 小时升级到上一级。</li>
        </ul>
        <p>上限由老板在「组织与设置」里按角色设置一次，之后不用管。调岗时上限跟着角色走，审计里仍保留当时的权限快照。</p>`,
      },
      {
        id: "roles",
        heading: "角色与可见范围",
        html: `
        <div class="table-wrap">
          <table class="price-table">
            <thead>
              <tr><th scope="col">角色</th><th scope="col">能看到</th><th scope="col">能做什么</th></tr>
            </thead>
            <tbody>
              <tr><td>老板</td><td>全公司</td><td>批所有金额；改角色与上限；看全部报表</td></tr>
              <tr><td>主管</td><td>本组客户与订单</td><td>批本组上限内金额；分配客户；看本组报表</td></tr>
              <tr><td>销售</td><td>本人负责的客户</td><td>派活、起草报价、寄样；批自己上限内的改幅</td></tr>
              <tr><td>跟单</td><td>本人负责的订单与寄样</td><td>更新进度、处理异常、发起对账</td></tr>
              <tr><td>财务</td><td>全公司单据，不含客户联系方式</td><td>确认回款、核对差异、导出对账单</td></tr>
              <tr><td>只读</td><td>管理员指定范围</td><td>只能看，不能改、不能批</td></tr>
            </tbody>
          </table>
        </div>
        <p>「看不到同事的客户」不是 bug，是数据范围在起作用。需要共享某个客户时，由主管把客户转给对应的人，或临时加一个协作成员，而不是放开所有人的可见范围。</p>`,
      },
      {
        id: "invite",
        heading: "邀请同事",
        html: `
        <ol>
          <li>「组织与设置 → 邀请同事」填同事邮箱、选角色，选通知方式（邮件 / 短信）。</li>
          <li>点「生成邀请链接」：配了发送通道就直接发给对方；没有就复制链接自己发微信（7 天有效）。</li>
          <li>对方打开链接、登录后点「接受邀请」，就成为这间公司的成员。</li>
        </ol>
        <p>只有老板和主管能邀请人；角色不能选「老板」（一间公司只有一个创建者）。加人等于授予数据范围与审批额度，所以邀请要核对邮箱，链接被转发也用不了。</p>`,
      },
      {
        id: "handover",
        heading: "人走了，客户怎么交接",
        html: `
        <p>客户属于公司，不属于个人。业务员离职时按下面三步，客户和上下文一起转走，不会「人走单断」：</p>
        <ol>
          <li>主管在客户列表里筛选「负责人 = 离职同事」，批量转给接手人。</li>
          <li>选择「一并移交」：历史报价、寄样记录、客户偏好、未结事项一起过去。</li>
          <li>系统给接手人一份交接清单；7 天后原账号自动失去这些客户的访问权。</li>
        </ol>
        <p>离职账号本身建议停用而不是删除，历史审批与审计记录要保留，后续对账和争议都要用到。</p>`,
      },
      {
        id: "audit",
        heading: "每一步都留痕",
        html: `
        <p>批准、改价、驳回、转客户、改权限，每一个动作都会写一条审计：谁、什么时候、在什么角色下、做了什么、改前改后是什么。审计记录只能追加，不能修改或删除。</p>
        <p>需要查某个报价为什么是这个价，从报价详情点「历史」就能看到完整链条。这也是我们对账争议时的依据。</p>`,
      },
    ],
  },

  {
    slug: "quotes.html",
    title: "报价与客户查看",
    description:
      "报价草稿怎么来、改价与版本、把报价发给客户、客户看到什么、客户接受之后发生什么、报价单打印。",
    lede: "报价是织序最常被用到的功能，也是最能看出「智能体干活、人审批」的地方。这一页从客户的一句话讲到客户点接受。",
    sections: [
      {
        id: "draft",
        heading: "草稿是怎么来的",
        html: `
        <p>你把客户原话贴进命令栏，或者从客户详情点「新建报价」，智能体会做三件事：</p>
        <ul>
          <li><strong>找样</strong>：按品名、成分、克重、门幅匹配你库里的样品，给出候选与命中理由。</li>
          <li><strong>核价</strong>：读成本底线、这个客户的历史价、当前毛利要求，算出建议单价。</li>
          <li><strong>起草</strong>：生成带明细的报价草稿，缺失项单独标出来。</li>
        </ul>
        <p>草稿不会自动发出去。它只在审批窗口等你，直到你点批准。</p>`,
      },
      {
        id: "revise",
        heading: "改价与版本",
        html: `
        <p>点「改一处」可以直接改数字，也可以写一句人话，例如「按客户要求让 1%，其余不变」。两种方式都会生成新版本（v2、v3），旧版本保留可查。</p>
        <p>改幅规则：</p>
        <ul>
          <li>5% 以内且金额不超过 1 万元：你自己就能批。</li>
          <li>超过 5% 或 1 万元：自动升级主管，卡片提示升级给了谁。</li>
          <li>低于成本底线：不允许批，只能改到线以上或驳回。</li>
        </ul>
        <p>客户还价时，不要在微信里心算。把客户那句还价贴进来，让智能体按新价重算毛利，再决定让不让。</p>`,
      },
      {
        id: "share",
        heading: "发给客户",
        html: `
        <p>批准后可以选两种发送方式：生成链接发微信，或下载 PDF 发邮件。链接是默认方式，因为它能记录客户看没看、看了多久。</p>
        <ul>
          <li><strong>有效期</strong>：默认 7 天，可设 24 小时到 30 天。</li>
          <li><strong>访问密码</strong>：可选，设置后客户需要输入你告诉他的四位数字。</li>
          <li><strong>水印</strong>：可选，把客户名和日期打在报价页上，防止截图外传。</li>
        </ul>
        <p>链接可以随时作废。作废后旧链接打开显示「报价已更新，请联系业务员」，不会泄露金额。</p>`,
      },
      {
        id: "customer",
        heading: "客户看到什么",
        html: `
        <p>客户不需要注册、不需要下载。手机点开就是一张干净的报价页：品名规格、单价总价、交期、账期、有效期，以及你的公司抬头和联系方式。</p>
        <p>页面底部有两个按钮：「我想问一句」和「接受这个报价」。客户留言会直接进你的工作台；接受会记录下来，但不会自动变成订单，仍需要你确认。</p>
        <p>客户视图里没有广告、没有弹窗、没有「下载 App」，也不会显示其他客户的信息。</p>`,
      },
      {
        id: "accept",
        heading: "客户接受之后",
        html: `
        <p>客户点「接受」后，你会收到一条待办：确认订单。确认时系统会把报价里的品名、数量、单价、交期带过去，生成订单草稿与应收计划。</p>
        <p>如果客户只是口头说「可以」，把他的话贴进工作台，同样能转成订单草稿，并保留这句原话作为依据。</p>`,
      },
      {
        id: "print",
        heading: "打印报价单",
        html: `
        <p>需要纸质件时，用桌面版的打印代理直接出单，模板里公司抬头、银行信息、条款都取自组织设置，不用每次改 Word。</p>
        <p>没有桌面版也可以先用浏览器打印成 PDF。模板与打印设置见<a href="printing.html">打印与单证</a>。</p>`,
      },
    ],
  },

  {
    slug: "printing.html",
    title: "打印与单证",
    description:
      "织序打印代理怎么装、支持哪些标签机与针式打印机、模板与字段、打印队列与重打、打不出来怎么排查。",
    lede: "打印是纺织贸易里最容易出问题的一环：纸不一样、机器不一样、字段经常缺。这一页按「装、配、打、救」四步写。",
    sections: [
      {
        id: "install",
        heading: "装打印代理",
        html: `
        <p>打印代理随桌面版一起安装，不需要单独下载。装好后打开「设置 → 打印」，代理会自动找局域网里的打印机。</p>
        <ol>
          <li>装桌面版（<a href="../download.html">下载页</a>，内测期间登记后发放）。</li>
          <li>打开「设置 → 打印」，点「扫描打印机」，选中你的机型。</li>
          <li>打一张测试页，确认走纸位置与浓度。</li>
        </ol>
        <p>代理只在你的电脑上接收打印任务，单据内容不上传到我们服务器再下发，避免网络抖动导致打一半。</p>`,
      },
      {
        id: "models",
        heading: "支持哪些机器",
        html: `
        <div class="table-wrap">
          <table class="price-table">
            <thead>
              <tr><th scope="col">类型</th><th scope="col">协议 / 机型</th><th scope="col">用于</th></tr>
            </thead>
            <tbody>
              <tr><td>标签机</td><td>Zebra（ZPL）、TSC（TSPL）、佳博、立象</td><td>箱唛、吊牌、物料标签</td></tr>
              <tr><td>针式打印机</td><td>爱普生 LQ 系列、映美、富士通</td><td>发货单、对账单（多联）</td></tr>
              <tr><td>A4 激光 / 喷墨</td><td>系统驱动支持的任意机型</td><td>报价单、合同附件</td></tr>
              <tr><td>小票机</td><td>ESC/POS</td><td>拣货单、交接单</td></tr>
            </tbody>
          </table>
        </div>
        <p>你的机型不在表里也能试：先在系统里装好驱动，用 A4 或小票方式打；打出来位置不对，把型号和一张照片发给我们，我们加适配。</p>`,
      },
      {
        id: "templates",
        heading: "模板与字段",
        html: `
        <p>系统自带一套默认模板，覆盖箱唛、发货单、拣货单、报价单、对账单。字段取自单据本身，不会出现「模板里有但数据没有」的空格：缺字段会在打印前预检并列出。</p>
        <ul>
          <li><strong>公司抬头、银行信息、条款</strong>：在「组织与设置 → 打印抬头」里改一次，所有模板生效。</li>
          <li><strong>一单一码</strong>：每张单有二维码，扫码可回到对应单据，也能用于扫码重打。</li>
          <li><strong>自定义模板</strong>：定制版可改版式，普通版可以调字号与边距。</li>
        </ul>`,
      },
      {
        id: "queue",
        heading: "打印队列与重打",
        html: `
        <p>所有打印都进队列，能看到「已发送 / 已打印 / 失败」。失败的任务可以一键重试，不会重复出纸（同一个单据、同一个版本、同一份数重复点击会被合并）。</p>
        <p>客户说没收到纸质单？在单据详情点「重打」，选份数即可；每张纸的打印记录都会写进审计，谁在什么时候重打了什么，一查就知道。</p>`,
      },
      {
        id: "trouble",
        heading: "打不出来怎么排查",
        html: `
        <ul>
          <li><strong>任务一直「已发送」</strong>：代理没连上打印机。检查 USB / 网络、机器是否休眠，然后在设置里重新扫描。</li>
          <li><strong>打出来是乱码</strong>：协议选错。标签机型号是 TSPL 却选了 ZPL，改回来即可。</li>
          <li><strong>位置偏移</strong>：在打印机设置里做一次测纸 / 校准，再在代理里调边距。</li>
          <li><strong>缺字段</strong>：单据本身没填，先补数据再打。预检会告诉你缺哪一个。</li>
          <li><strong>针式打印机多联不清楚</strong>：调浓度与击打力度，或换复写纸；这不是软件问题。</li>
        </ul>
        <p>还搞不定就把机型、连接方式（USB / 网口）、一张打废的纸拍给我们。</p>`,
      },
    ],
  },

  {
    slug: "agent.html",
    title: "智能体与命令行",
    description:
      "让 codex 等智能体直接操作织序：命令行安装与登录、常用命令示例、skill 加载、权限边界与凭据管理。",
    lede: "这一页给愿意用命令行的人。用不用都不影响正常使用网页版，它的价值是让别的智能体（codex、Claude Code 等）通过一个受控入口帮你查数和起草。",
    sections: [
      {
        id: "what",
        heading: "这条通道是给谁用的",
        html: `
        <p>给两类人：一是习惯终端、想批量查数的老板和主管；二是想让外部智能体帮忙操作织序的开发者。命令行的权限和你登录的账号完全一致，不会因为走命令行就多看到数据。</p>
        <div class="docs-callout">
          <b>命令行不是后门。</b> 它调用的是同一套业务接口，同样受角色、数据范围和审批规则约束；它能起草，但不能批准。
        </div>`,
      },
      {
        id: "install",
        heading: "安装与登录",
        html: `
        <p>需要 Node 20 及以上。内测期间 npm 包尚未公开发布，从仓库构建：</p>
        <pre><code>git clone git@github.com:sjzsdu/weave-order.git
cd weave-order
pnpm install
pnpm --filter @weave-order/cli build
node apps/cli/bin/weave.js --help</code></pre>
        <p>登录用设备码，不需要在命令行里敲密码：</p>
        <pre><code>weave login
# 打开给出的链接，在浏览器里确认，命令行自动完成登录</code></pre>
        <p>登录凭据存在本机，按设备区分。可以随时用 <code>weave token list</code> 查看、<code>weave token revoke</code> 撤销。</p>`,
      },
      {
        id: "examples",
        heading: "常用命令",
        html: `
        <pre><code># 看今天等你决定的事
weave approvals list

# 查一个客户的历史报价
weave quotes list --customer 青禾纺织

# 把客户原话变成报价草稿（仍需人在界面上批准）
weave quote draft --customer 青禾纺织 \\
  --text "32S 精梳棉氨纶汗布 180g，3.2 吨，问上次价能否再让 1%"

# 拉某个订单的进度
weave orders show --id ORD-1024

# 导出对账单
weave statements export --month 2026-10 --format xlsx</code></pre>
        <p>命令的确切参数以 <code>weave &lt;命令&gt; --help</code> 为准；版本升级时我们会保持命令名稳定，只增不改。</p>`,
      },
      {
        id: "skill",
        heading: "让 codex 这类智能体学会用它",
        html: `
        <p>仓库里有 <code>skills/weave-order/SKILL.md</code>，它告诉外部智能体：有哪些工具、参数是什么、什么不能做。把这一份放进你的智能体技能目录，它就能自己调用：</p>
        <pre><code>weave skill install            # 装到默认技能目录
weave skill path               # 看装到了哪里</code></pre>
        <p>装好之后，你可以对 codex 说「查一下青禾这个月的报价，按毛利排个序」，它会调用织序的命令取数，而不是编数字。</p>`,
      },
      {
        id: "limits",
        heading: "能做与不能做",
        html: `
        <div class="table-wrap">
          <table class="price-table">
            <thead><tr><th scope="col">能做</th><th scope="col">不能做</th></tr></thead>
            <tbody>
              <tr><td>查客户、样品、报价、订单、对账</td><td>批准或驳回任何草稿</td></tr>
              <tr><td>起草报价、寄样单、对账单</td><td>改账、删单、改历史金额</td></tr>
              <tr><td>拉审批列表、看审计</td><td>改角色与权限</td></tr>
              <tr><td>导出报表</td><td>导出别人数据范围内的客户</td></tr>
            </tbody>
          </table>
        </div>
        <p>这些边界写在服务端，不靠命令行自觉：即使改命令行代码，也拿不到多余权限。</p>`,
      },
      {
        id: "tokens",
        heading: "凭据与安全",
        html: `
        <ul>
          <li>凭据按设备签发，换电脑要重新登录，旧设备可以单独撤销。</li>
          <li>撤销后 1 分钟内生效，已发出的请求会在下一次调用被拒。</li>
          <li>不要把凭据写进代码仓库或共享给同事；需要给同事接入，让他自己登录一次。</li>
          <li>在「组织与设置 → 登录设备」能看到所有已登录设备，一键下线。</li>
        </ul>`,
      },
    ],
  },

  {
    slug: "security.html",
    title: "数据与安全",
    description:
      "织序的数据隔离方式、谁能看到你的客户、平台人员什么时候能看到数据、审计、导出、停用删除、模型使用与备份。",
    lede: "这一页写给会问「我的客户名单会不会被别人看到」的老板，也写给需要填安全问卷的 IT。我们尽量说人话，并给出可核对的机制。",
    sections: [
      {
        id: "isolation",
        heading: "数据怎么隔离",
        html: `
        <p>每个公司（我们叫「租户」）一个独立空间。默认所有公司共用一个数据库，但每条数据都带公司标识，数据库层面强制只返回属于你公司的行；这不是应用代码里的 if 判断，而是数据库策略。</p>
        <p>需要更严的合同，可以升级到独立 schema，或者独立数据库（定制版）。升级过程是导出、校验行数与金额、切换、保留回滚窗口，不是「重建账号」。</p>
        <div class="docs-figure">
          <b>你可以自己验证：</b>用 A 公司的账号登录，任何接口都拿不到 B 公司的客户、样品或报价，即使手动改请求参数也一样。发现例外，请立刻告诉我们，这属于严重缺陷。
        </div>`,
      },
      {
        id: "who",
        heading: "公司内部谁能看到什么",
        html: `
        <p>公司内部也不是人人可见。角色决定范围：销售只看自己的客户，主管看本组，财务看单据但默认不含客户联系方式，老板看全公司。</p>
        <p>客户交接时权限随客户走，7 天后原负责人自动失去访问权。所有权限变更都有记录，能还原「当时谁能看什么」。</p>`,
      },
      {
        id: "break-glass",
        heading: "平台人员什么时候能看到你的数据",
        html: `
        <p>默认看不到。平台运营与财务的控制台只存账号、订阅、用量汇总和账单，不存任何客户、报价明细、样品图与手机号。</p>
        <p>只有一种例外：你报障并书面同意后，我们的技术同事可以申请一次限时只读访问，用来定位问题。</p>
        <ul>
          <li>需要你在工单里明确同意，不是默认勾选。</li>
          <li>只读，最长 60 分钟，到期自动失效。</li>
          <li>全程留痕，事后给你一份访问记录。</li>
          <li>高危操作（删租户、强制改套餐）需要两个人复核，单人做不了。</li>
        </ul>`,
      },
      {
        id: "audit",
        heading: "审计：改不了的历史",
        html: `
        <p>业务写入和审计写入在同一个事务里，要么都成功要么都不成功。审计表在数据库层面禁止修改与删除，谁也不能「擦掉」一条记录。</p>
        <p>每条记录包含：时间、操作者、当时的角色与数据范围、动作、改前改后。对账有争议、报价被质疑时，这条链就是依据。</p>`,
      },
      {
        id: "export",
        heading: "随时导出，随时带走",
        html: `
        <p>客户、样品、报价、订单、对账都能导出成 Excel，不需要申请、不额外收费。导出记录本身也会写审计，方便你知道谁导过什么。</p>
        <p>停用账号后，数据保留 90 天可恢复；超过保留期按合同处理，删除前会通知你。</p>`,
      },
      {
        id: "delete",
        heading: "停用与删除",
        html: `
        <p>「停用」是关掉登录、保留数据；「删除」是不可恢复的。两个动作分开，避免误操作。</p>
        <ul>
          <li>停用：管理员随时可做，恢复也随时可做。</li>
          <li>删除租户：需要你书面申请 + 平台两人复核，执行前会给一份数据导出包。</li>
          <li>删除某个客户或样品：软删除，30 天内可恢复。</li>
        </ul>`,
      },
      {
        id: "model",
        heading: "模型与你的数据",
        html: `
        <p>智能体调用大模型时，只传当次任务需要的内容：这次要报的品名、规格、相关样品与历史价。不会把整库数据发出去，也不会把你公司的数据用于训练模型。</p>
        <p>不同公司之间的数据在模型调用层面完全隔离，不存在「隔壁公司的报价被学走」。</p>`,
      },
      {
        id: "backup",
        heading: "备份与可用性",
        html: `
        <p>数据库每日全量备份 + 持续增量，保留 30 天；备份加密存放，定期做恢复演练。登录服务与业务服务分开部署，登录服务故障时已登录的会话有短期宽限，不打断正在做的审批。</p>
        <p>需要具体的 SLA、等保材料或安全问卷，写信到 <a href="mailto:hello@weaveorder.cn">hello@weaveorder.cn</a>。</p>`,
      },
    ],
  },

  {
    slug: "faq.html",
    title: "常见问题",
    description:
      "织序 WeaveOrder 常见问题：是什么、和布管家有什么区别、怎么开通、数据安全吗、能不能私有化、价格怎么算、登录不上怎么办。",
    lede: "把散落在各页的问题集中在这里。每条都尽量先给结论，再给原因；想深入看某一篇，链接在答案里。",
    extraJsonLd: `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "织序 WeaveOrder 是什么？",
      "acceptedAnswer": { "@type": "Answer", "text": "织序是纺织贸易的智能体原生业务操作系统。找样、报价、寄样跟进、订单跟踪、对账与打印单证由智能体完成，人只在审批卡上做决定。" }
    },
    {
      "@type": "Question",
      "name": "织序和布管家这类纺织 ERP 有什么区别？",
      "acceptedAnswer": { "@type": "Answer", "text": "布管家类软件的前提是业务员操作软件、逐字段录入；织序的前提是智能体是默认操作者，人只审批结果。功能表相近，但中间不再需要人搬数据。" }
    },
    {
      "@type": "Question",
      "name": "怎么开通织序？要多久？",
      "acceptedAnswer": { "@type": "Answer", "text": "在官网登记公司与联系人，工作日当天我们会发一条开通链接。点开链接、用统一账号登录，公司空间当场建好，你成为老板账号，3 天全功能试用，不绑卡、不收开通费。" }
    },
    {
      "@type": "Question",
      "name": "智能体会不会自己把报价发给客户？",
      "acceptedAnswer": { "@type": "Answer", "text": "不会。智能体只能产出草稿，必须由人点批准才生效。改幅超过 5% 或 1 万元自动升级主管，低于成本底线直接拦下。" }
    },
    {
      "@type": "Question",
      "name": "数据安全吗？平台人员能看到我的客户吗？",
      "acceptedAnswer": { "@type": "Answer", "text": "默认看不到。平台控制台只存账号、订阅与用量汇总，不存客户与报价明细。只有你报障并书面同意后，技术同事才能申请一次限时只读访问，全程留痕。" }
    },
    {
      "@type": "Question",
      "name": "支持私有化部署吗？",
      "acceptedAnswer": { "@type": "Answer", "text": "支持。定制版可以独立数据库、对接企业已有登录与组织架构，数据留在你指定的区域，按年度合同报价。" }
    },
    {
      "@type": "Question",
      "name": "价格怎么算？",
      "acceptedAnswer": { "@type": "Answer", "text": "按公司订阅：基础 299 元每月（含 5 个账号、20,000 credits），专业 899 元每月（含 20 个账号、100,000 credits），企业 2,999 元每月起。1 credit = 1,000 tokens，超额暂停智能体并提醒，不自动扣费；年付为 10 个月价。" }
    },
    {
      "@type": "Question",
      "name": "客户看报价需要注册吗？",
      "acceptedAnswer": { "@type": "Answer", "text": "不需要。报价链接打开即可查看，能留言、能接受，不需要下载 App。链接可设有效期与访问密码。" }
    }
  ]
}
</script>`,
    sections: [
      {
        id: "start",
        heading: "产品是什么",
        html: `
        <h3>织序到底解决什么问题？</h3>
        <p>解决「中间搬数据的人」：客户一句话进来，过去要业务员选菜单、查样品、算价、写 Word、发微信；现在智能体把这些做完，人只在一张卡上批准。<a href="../index.html#why">看和记录型软件的区别</a></p>
        <h3>适合多大的公司？</h3>
        <p>5 到 50 人、业务员 3 到 20 人、靠微信接单的面料与服装贸易公司。更大的集团走定制版，更小的夫妻档用基础版也够。</p>
        <h3>一定要全员切换吗？</h3>
        <p>不用。先让一个业务员跑报价链路，跑通再接第二个人。数据是公司级的，接人不需要迁移。</p>`,
      },
      {
        id: "cost",
        heading: "价格与合同",
        html: `
        <h3>试用多久？要不要绑卡？</h3>
        <p>3 天全功能，不绑卡、不需要付费信息，到期不自动扣费。<a href="signup.html#trial">看试用规则</a></p>
        <h3>为什么不按人头收费？</h3>
        <p>按人头收费会逼你在「多拉一个人」时先算钱。我们按公司收固定月费，账号数含在套餐里；变动的是 AI 用量（credits），超了只暂停智能体并提醒，不自动扣费。<a href="../pricing.html#billing-rules">看计费规则</a></p>
        <h3>能开发票吗？</h3>
        <p>能开增值税普通发票与专用发票，付款后 3 个工作日内开出电子票。<a href="signup.html#billing">看开票步骤</a></p>`,
      },
      {
        id: "data",
        heading: "数据与安全",
        html: `
        <h3>我的客户会不会被别的公司看到？</h3>
        <p>不会。每个公司一个独立空间，数据库层面强制隔离，应用代码写错也拿不到别家的数据。<a href="security.html#isolation">看隔离机制</a></p>
        <h3>数据会被拿去训练模型吗？</h3>
        <p>不会。模型只接收当次任务需要的内容，不用于训练，不跨公司共享。<a href="security.html#model">看说明</a></p>
        <h3>能把数据带走吗？</h3>
        <p>随时导出 Excel，免费、不需要申请。停用后保留 90 天。<a href="security.html#export">看导出</a></p>
        <h3>能不能私有化？</h3>
        <p>可以，定制版支持独立数据库与对接企业统一登录。<a href="../signup.html">联系我们</a></p>`,
      },
      {
        id: "login",
        heading: "登录与账号",
        html: `
        <h3>登录入口在哪？</h3>
        <p><a href="../login.html">官网登录页</a>，或直接打开 <a href="https://weave.wnbgj.com" rel="noopener">weave.wnbgj.com</a>。</p>
        <h3>忘记密码怎么办？</h3>
        <p>密码由公司统一身份系统管理，在统一登录页点「忘记密码」按提示重置，1 分钟内生效。织序看不到也改不了你的密码。</p>
        <h3>提示账号不存在 / 没开通？</h3>
        <p>说明你还没被加入公司空间。把要加入的公司名和你自己的邮箱发给老板或对接人，让他们把你加进来；加好后用同一个账号登录即可。<a href="quickstart.html#invite">看加入方式</a></p>
        <h3>同事能共用账号吗？</h3>
        <p>不建议，也会被规则挡住：审计要记录到人，审批上限按角色算，共用账号等于让所有人拥有同一个权限。多一个人就多一个可追责的身份。</p>`,
      },
      {
        id: "permission",
        heading: "权限与协作",
        html: `
        <h3>为什么看不到同事的客户？</h3>
        <p>数据范围在起作用：销售默认只看本人客户。需要共享时由主管转客户，而不是放开全局可见。<a href="approvals.html#roles">看角色表</a></p>
        <h3>谁能批准大额报价？</h3>
        <p>超过角色上限的金额自动升级主管；改幅超过 5% 或 1 万元同样升级。<a href="approvals.html#limits">看升级规则</a></p>
        <h3>业务员离职，客户会跟着走吗？</h3>
        <p>不会。客户属于公司，交接时历史报价与偏好一起转走，7 天后原账号失去访问权。<a href="approvals.html#handover">看交接</a></p>`,
      },
      {
        id: "ops",
        heading: "日常使用",
        html: `
        <h3>Excel 能直接导进来吗？</h3>
        <p>能，客户和样品两个文件分开导。有一行不合格就整批不入库，报错会指出哪一行哪一列。<a href="import.html">看导入规则</a></p>
        <h3>支持哪些打印机？</h3>
        <p>Zebra、TSC、佳博等标签机，爱普生等针式打印机，以及系统驱动支持的任何 A4 打印机。<a href="printing.html#models">看机型</a></p>
        <h3>手机能用吗？</h3>
        <p>能。手机浏览器打开后添加到主屏幕即可，拍照、扫码、语音派活、车上批单都支持；批量导入与权限配置在电脑上做。<a href="../download.html">看下载</a></p>
        <h3>断网了怎么办？</h3>
        <p>桌面版与手机端会把扫码、拍照、派活先存本地，恢复后自动补交，不会丢单。</p>`,
      },
      {
        id: "agent",
        heading: "智能体接入",
        html: `
        <h3>能用 codex 直接操作织序吗？</h3>
        <p>能，通过 <code>weave</code> 命令行与 skill。权限和你本人一致，能起草不能批准。<a href="agent.html">看接入文档</a></p>
        <h3>智能体会不会乱改数据？</h3>
        <p>不会。它只能做我们开放的固定操作，产出停在草稿；写账、改历史金额、改权限都不在它的能力范围里。</p>`,
      },
      {
        id: "contact",
        heading: "还是没解决",
        html: `
        <p>写信到 <a href="mailto:hello@weaveorder.cn">hello@weaveorder.cn</a>，写清三件事：你点了什么、期望什么、实际看到什么。附截图。工作日 4 小时内回复。</p>
        <p>需要演示或开通，走<a href="../signup.html">开通页</a>，我们当天处理。</p>`,
      },
    ],
  },
];

/* ======================================================================== */

for (const page of pages) {
  const file = join(outDir, page.slug);
  writeFileSync(file, render(page), "utf8");
  console.log("wrote", file);
}
