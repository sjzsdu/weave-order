# 织序 WeaveOrder · 官网与帮助中心

官网是 monorepo 里的一个包（`@weave-order/site`），和 `apps/web`、`apps/admin` 地位一样：
Astro 5 + Tailwind 4 + MDX 内容集合，构建期产出纯静态 HTML，nginx 托管。

产物仍然是一堆静态文件（`dist/`），地址一个没变（`/pricing.html`、`/docs/import.html`）——
换框架不换地址，搜索权重不掉。

## 现在有哪些页面

| 路径                                                                     | 作用                                                                | 谁维护                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------- |
| `index.html`                                                             | 首页：定位、能力、五步链路、规则与留痕、双端、价格、FAQ、预约演示   | `src/pages/index.astro`            |
| `pricing.html`                                                           | 价格、计费口径、发票与套餐变更、购买前的问题                        | `src/pages/pricing.astro`          |
| `signup.html`                                                            | 免费试用 / 开通：三步旅程、登记表单、开通前准备、常见问题           | `src/pages/signup.astro`           |
| `download.html`                                                          | 下载：网页版、Windows / macOS、手机 PWA、打印代理、命令行、运行环境 | `src/pages/download.astro`         |
| `login.html`                                                             | 登录入口：工作台、平台管理、忘记密码、四类登录问题                  | `src/pages/login.astro`            |
| `legal.html`                                                             | 服务条款与隐私政策（可读版）                                        | `src/pages/legal.astro`            |
| `docs/index.html`                                                        | 帮助中心首页：按任务分类 + 搜索 + 十个高频问题                      | `src/pages/docs/index/index.astro` |
| `docs/quickstart.html`                                                   | 5 分钟上手                                                          | `src/pages/docs/quickstart.astro`  |
| `docs/{signup,import,approvals,quotes,printing,agent,security,faq}.html` | 七篇操作文档与 FAQ                                                  | `src/content/docs/*.mdx`           |
| `guides/{textile-erp-selection,fabric-quotation-software,sample-follow-up,textile-reconciliation}.html` | 四个长尾搜索意图落地页（选型 / 报价 / 寄样 / 对账） | `src/content/guides/*.mdx` |
| `404.html`                                                               | 找不到页面时的四个出口                                              | `src/pages/404.astro`              |
| `llms.txt`                                                               | 给 AI 助手（ChatGPT / Claude / Perplexity 等）的产品摘要与事实清单  | `public/llms.txt`                  |
| `robots.txt` / `sitemap.xml`                                             | 抓取规则与站点地图                                                  | `public/robots.txt` + 构建集成     |

页头、页脚、SEO 元信息、JSON-LD 在 `src/layouts/` 与 `src/components/` 里各有一份，
改一处全站生效。

## 本地预览

```bash
pnpm --filter @weave-order/site dev     # 开发服务器，默认 http://localhost:4321
pnpm --filter @weave-order/site build   # 构建到 dist/
pnpm --filter @weave-order/site preview # 预览构建产物
pnpm --filter @weave-order/site test    # 构建 + 产物体检（页面、SEO、链接、sitemap、搜索）
```

`build` 会先跑 `scripts/sync-tokens.mjs`：从 `packages/ui/src/tokens.ts` 生成
`src/styles/theme.css`（Tailwind v4 的 `@theme` 变量）。所以改品牌色只改
`packages/ui` 一处，站点和其它应用同步。

构建的最后一步是 `scripts/build-search-index.mjs`：从 `dist/**/*.html` 抽取
「页面 → 章节」结构，生成 `dist/search-index.json`。它不读源码，读的是渲染后的
HTML，所以首页、价格、下载这些非 Markdown 页面也进索引；`<header>`、`<footer>`、
`<aside>` 会被剔掉，避免每篇文档都因为侧栏目录而命中。

## 站内搜索

纯前端，没有后端、不联网、不埋点：

- 入口：页头「搜索」按钮、`⌘K` / `Ctrl+K`、`/`、`?q=报价` 直接打开
- 匹配：`src/lib/search.ts`（纯函数，有单测）。中文按二元组切词，英文按词切；
  标题 > 章节标题 > 描述 > 正文加权，结果直接带章节锚点
- 界面：`src/scripts/search.ts` 负责对话框、键盘上下选择、Esc 关闭、焦点回收
- 帮助中心目录的输入框会就地筛选卡片，按 Enter 升级成全站搜索

开发服务器（`astro dev`）不产出 `dist/search-index.json`，搜索会提示索引未生成；
跑一次 `build` 或 `preview` 即可。索引随页面内容一起发版，没有单独的数据管道。

## 改帮助文档

帮助中心的八篇文章是 MDX（`src/content/docs/*.mdx`），带 frontmatter：

```mdx
---
title: "开通、试用与付费"
description: "……"
lede: "……"
file: "signup.html" # 站内文件名（不叫 slug：那是 Astro 的保留字段）
order: 2 # 阅读顺序，上一篇 / 下一篇按它排
sections: # 本页目录
  - id: "link"
    heading: "开通：自己创建，或接受邀请"
---
```

新增一篇文章：在 `src/content/docs/` 加一个 `.mdx`，再把它加进 `src/data/docs-nav.json`
（侧栏）与 `src/data/docs-order.json`（阅读顺序），最后补 `src/integrations/xml-sitemap.mjs`
里的地址表 —— `pnpm --filter @weave-order/site test` 会检查这三处是否一致。

## 改指南页（长尾落地页）

`guides/` 下四页回答客户会直接搜的问题，目标是被搜索引擎与大模型单独摘录。它们是独立的内容集合，和帮助文档共用版式类，但多一层首屏与转化区：

- 正文：`src/content/guides/*.mdx`。frontmatter 里的 `h1`、`answer`、`aside`、`cta` 渲染首屏与页尾，`sections` 生成本页目录，`faq` 同时生成可见问答与 `FAQPage`，可选 `howTo` 额外生成 `HowTo`。
- 外壳：`src/layouts/GuideLayout.astro`（首屏 + 指南目录 + 正文 + 目录 + FAQ / CTA / 上下篇）；路由在 `src/pages/guides/[...slug].astro`，URL 取 frontmatter 的 `file`（保留 `.html`）。
- 新增一篇：加一个 `.mdx`，把侧栏项补进 `src/data/guides-nav.json`（本页导航）与 `src/data/docs-nav.json`（帮助文档侧栏的「指南」分组），再补 `src/integrations/xml-sitemap.ts` 的地址表与 `public/llms.txt` 的「指南」分组 —— `test` 会检查地址表与页面是否一致。
- 每页正文建议 ≥ 800 字中文、至少 3 个可核对的具体机制或数字；没有真实客户数据就写方法，不编案例。
- CTA 带 `data-cta`（位置枚举）+ `data-cta-label`（指南名），统计接入后按事件字典绑 `cta_click`。

## SEO 与「大模型搜索」优化

搜索引擎部分：

- 每页都有唯一的 `<title>`、`meta description`、`canonical`、Open Graph 与 Twitter Card；`og:image` 用绝对地址。
- 结构化数据：首页 `Organization` + `WebSite` + `SoftwareApplication` + `FAQPage`；价格页 `Product` + `Offer`；开通页 `HowTo`；文档页 `BreadcrumbList`；FAQ 页 `FAQPage`。
- `sitemap.xml` 含全部 20 个可索引页面；`robots.txt` 声明 sitemap，并显式允许 GPTBot / ClaudeBot / PerplexityBot。
- 语义结构：每页一个 `h1`，章节用 `h2/h3`，正文用短段落与列表；`alt` 全部填写或显式留空。
- 登录后的工作台与平台管理端在应用层设置了 `noindex`，不参与索引。

大模型搜索（AEO / GEO）部分：

- `llms.txt` 放在站点根目录，按 [llmstxt.org](https://llmstxt.org) 的格式给出：一句话定义、关键事实（入口、价格、试用、开通方式、部署形态、身份、安全）、分主题链接、可直接引用的问答对。首页 `<head>` 里有 `<link rel="alternate" type="text/plain" href="/llms.txt">`。
- 每个页面开头先给结论，再给细节；FAQ 每条答案都能独立被摘出来（「不」开头也是完整句子）。
- 事实一致：同一组数字（299 / 899 / 3 天 / 5% / 1 万元）在首页、价格页、帮助中心、`llms.txt` 里保持一致，避免模型引用到互相矛盾的版本。
- 不写「行业领先」这类无法验证的话；给可核对的具体机制（数据库层隔离、审计只追加、break-glass 限时只读）。

## 文案规则

这是面向老板和业务员的站点，不是技术文档：

1. 先说「你能得到什么」，再说「怎么做到的」。
2. 不出现内部术语：内核、前端 / 后端、DRAFT、SSR、token 计费、tenant_id、幂等键、触发器。要表达同样意思时说人话（「金额不会算错」「点开就能看」「重复点击不会重复出纸」）。
3. 数字必须能用：几分钟、多少钱、多少人、几号之前。
4. 不确定的事直接说「内测中」「登记后发放」，不承诺做不到的即时开通。

## 上线：域名在部署时配，不写死在页面里

页面里所有绝对地址都来自 `src/site.config.json`。换域名不用改文件、不用重新构建、
不用重新发 tag —— 部署环境给容器喂环境变量，容器启动时把域名渲染进页面
（`docker/entrypoint.sh` + `scripts/prepare-config.mjs`）。

| 环境变量              | 对应配置项 | 用途                   | 留空时                       |
| --------------------- | ---------- | ---------------------- | ---------------------------- |
| `WEAVE_SITE_URL`      | `site`     | canonical、OG、sitemap | 沿用 `site.config.json` 的值 |
| `WEAVE_APP_URL`       | `app`      | 登录 / 打开工作台      | 同上                         |
| `WEAVE_ADMIN_URL`     | `admin`    | 平台管理入口           | 同上                         |
| `WEAVE_SSO_URL`       | `sso`      | 忘记密码、统一登录     | 同上                         |
| `WEAVE_SUPPORT_EMAIL` | `email`    | 咨询、开通、账单       | 同上                         |
| `WEAVE_ANALYTICS_PROVIDER` | `analytics.provider` | 访问统计开关（`plausible` / `posthog` / `none`） | `none`，完全静默 |
| `WEAVE_ANALYTICS_DOMAIN`   | `analytics.domain`   | Plausible 统计的站点域名 | 空 |
| `WEAVE_ANALYTICS_HOST`     | `analytics.host`     | 自建统计地址（必须是 https，本地回环除外） | 官方默认 |
| `WEAVE_ANALYTICS_KEY`      | `analytics.key`      | PostHog project key | 空 |

deploy 仓库的 compose 已经按这套变量传参，`.env` 里改域名 + `docker compose up -d` 即可。

当前默认值（部署时按实际环境覆盖）：

| 配置项  | 当前值                          | 用途                         |
| ------- | ------------------------------- | ---------------------------- |
| `site`  | `https://weaveorder.cn`         | canonical、OG、sitemap、llms |
| `app`   | `https://weave.wnbgj.com`       | 登录 / 打开工作台            |
| `admin` | `https://weave-admin.wnbgj.com` | 平台管理入口                 |
| `sso`   | `https://sso.wnbgj.com`         | 忘记密码、统一登录           |
| `email` | `hello@weaveorder.cn`           | 咨询、开通、账单             |

另有三件不在这个脚本范围内：

1. **应用侧两个环境变量**：`apps/web` 的 `NEXT_PUBLIC_MARKETING_URL`（登录页指向官网）与 `NEXT_PUBLIC_SUPPORT_EMAIL`；统一登录地址直接复用 `CASDOOR_ISSUER`。
2. **Casdoor 应用回调**：`weave-order-web` 的 redirect URI 必须包含 `<应用域名>/auth/callback`。应用本身不要求固定域名：没设 `PUBLIC_APP_URL` 时按请求来源推导。
3. **备案号**：若部署在国内服务器，页脚需要补 ICP 备案号与公安备案号。

## 开通：现在怎么走

两种入口，都不需要运营逐单点：

1. **老板自助创建**：登录 → `/start` 填公司名 → `POST /api/onboarding/start`建业务库租户 + OWNER 成员；随后由服务端调用控制面 `/platform/api/internal/tenants` 补登记试用订阅。控制面失败不阻断使用，按 slug 可补录。
2. **员工接受邀请**：老板/主管在「组织与设置 → 邀请同事」填邮箱+角色 → 生成 7 天有效的签名链接 → 员工打开 `/join?code=…`、登录、点接受 → `INVITED` 成员换成真实 `sub` 并激活。

邀请链接会即时尝试发送（邮件默认、短信需手机号）：`NOTIFY_PROVIDER=webhook` 指向自建网关，网关再去调邮件/短信服务商；未配置时如实显示「没有发出通知，请复制链接手动发送」。

试用到期任务：`pnpm --filter @weave-order/platform-api trial-sweep`，用 cron / systemd timer 每天跑一次。到期前 1 天提醒（2 天内不重复），到期当天把租户与订阅转 `SUSPENDED`（只读，数据保留）。

两套链接共用 `ONBOARDING_SECRET` 签名的票据，只是 `kind` 不同（`tenant` / `invite`）；票据核对登记/被邀请邮箱，转发无效。平台侧「生成开通链接」保留给「先谈合同、后上线」的企业客户。

完全不经过人工的开放式注册（不要求邮箱验证、不限流）仍然不做：现在的前提是用户已在统一身份系统里注册并验证过邮箱/手机。Casdoor 的注册项（邮箱/手机号 + 验证码、是否允许自助注册）属于部署配置，不在本仓库。

## 访问统计

官网与工作台（`apps/web`）共用一套 cookieless 事件（Plausible / PostHog 二选一，按部署环境切换，默认 `none`）。没有 Cookie 同意弹窗：不写 Cookie、不做跨站追踪、不采集邮箱 / 手机号 / 客户名，只发匿名事件本身。

### 事件表

| 事件                   | 触发点                                                     | 属性                        | 说明                                                                        |
| ---------------------- | ---------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------- |
| `pageview`             | 自动                                                       | —                           | 页面浏览。Plausible 脚本自带；PostHog 由我们的代码发，两个 provider 事件名一致 |
| `cta_click`            | 首页 / 价格页 / 开通页 / 下载页 / 页脚的关键按钮            | `location` `label` `target` | `label` 默认取链接文案，`target` 默认取 `href`；`location` 取值见下          |
| `signup_form_submit`   | 表单成功交给邮件客户端（首页预约、开通页登记）              | —                           | 只记「已经交给邮件客户端」，不读表单内容                                    |
| `login_click`          | 登录入口                                                   | `from`                      | `site-nav` / `site-hero` / `site-footer` / `login-page` / `activate-page`   |
| `activate_link_opened` | 工作台 `/activate` 预览成功                                | —                           | 开通链接真的被人打开（不是打开就关）                                        |
| `activate_completed`   | 工作台 `/activate` 领取成功                                | —                           | 成为公司老板账号                                                            |
| `invite_created`       | 工作台设置页「邀请同事」成功                               | `role`                      | 只记角色，不记同事邮箱与手机号                                              |
| `invite_accepted`      | 工作台 `/join` 接受邀请成功                                | `role`                      | 只记角色                                                                    |

`cta_click.location` 固定取值（表外的值收敛成 `other`，避免分组碎成长尾）：`nav`、`hero`、`pricing-card`、`pricing-cta`、`footer`、`docs`、`download`。

### 配置

统计配置和域名走同一套部署期机制：`src/site.config.json` 给默认值（默认 `provider: none`），容器启动时 `docker/entrypoint.sh` 按 `WEAVE_ANALYTICS_*` 渲染进页面的 `window.WEAVE_ANALYTICS`。**构建产物里是占位符**，本地 `preview` 时保持占位符 = 不认识的 provider = 完全静默，不会误发数据。

```bash
# 部署时（compose 的 environment 或 docker run -e）
WEAVE_ANALYTICS_PROVIDER=plausible
WEAVE_ANALYTICS_DOMAIN=weaveorder.cn
# 自建：WEAVE_ANALYTICS_HOST=https://stats.weaveorder.cn
# PostHog：WEAVE_ANALYTICS_PROVIDER=posthog WEAVE_ANALYTICS_KEY=phc_xxx
```

校验不过（provider 拼错、host 不是 https）只会告警并退回 `none`，不会把坏值写进页面。

工作台由服务端环境变量 `ANALYTICS_PROVIDER / DOMAIN / HOST / KEY` 经 `/config.js` 运行时下发，见 `apps/web/src/analytics.ts`。

### 给 CTA 加埋点

给链接加 `data-cta`，可选 `data-cta-label` / `data-cta-target` 覆盖默认文案与目标：

```astro
<a class="btn btn--primary" href="signup.html" data-cta="hero">免费试用 3 天</a>
<a class="btn btn--ghost" href="signup.html?plan=basic" data-cta="pricing-card"
   data-cta-label="基础套餐">开始 3 天试用</a>
<!-- 登录入口用 data-login，不要用 data-cta -->
<a class="btn btn--ghost" href="/login.html" data-login="site-nav">登录</a>
```

点击是事件委托（`public/assets/analytics.js` 捕获阶段监听），新增按钮不用改 `main.ts`。页面脚本要上报事件时用 `src/lib/track.ts` 的 `trackEvent()`，不要直接碰 `window.weaveAnalytics`。

### 加一个新事件

1. 在 `public/assets/analytics.js` 与 `apps/web/src/analytics.ts` 的 `EVENT_PROPS` 里**同时**加一行（两处必须一致，`apps/web/src/analytics.test.ts` 会比对整张字典）。
2. 属性只能放白名单里的键。值含 `@` 或 7 位以上连续数字会被丢弃（邮箱、手机号、单据号）。
3. 在触发点调 `trackEvent("事件名", { ... })`（官网）或 `track("事件名", {...})`（工作台）。
4. 补用例：`tests/analytics.test.ts`、`apps/web/src/analytics.test.ts`。
5. 在上面的「事件表」补一行，写清触发点与属性。

### 自查

- **未配置 provider**：`pnpm --filter @weave-order/site test` 覆盖「不注入脚本、不留全局变量」；浏览器打开首页，Network 里只有本站资源。
- **配置后**：点首页「免费试用 3 天」，Plausible 后台 Events 出现 `cta_click`，按 `location` 分组能看到 `hero`。
- **隐私**：点页脚邮箱链接，事件里不应出现 `hello@weaveorder.cn`（含 `@` 的值会被丢弃）。

## 计费模型（与代码一致）

- 按公司订阅：基础 ¥299 / 专业 ¥899 / 企业 ¥2,999 起，含固定账号数与每月 credits。
- 1 credit = 1,000 tokens（输入+输出）；credits 落在租户的 LLM 月度预算里，超额时智能体暂停（人仍可看/批/导出），每月 1 日重置。
- 年付 = 10 个月价；价格表版本化，租户合同价另存。
- 官网价格页、帮助中心与 `llms.txt` 用同一组数字，改价时一起改。

## 目录

```
apps/site/
├── src/
│   ├── pages/                  路由 → 页面（.astro）
│   │   ├── index.astro         首页
│   │   ├── pricing.astro / signup.astro / download.astro / login.astro / legal.astro
│   │   ├── 404.astro
│   │   └── docs/
│   │       ├── index/index.astro   帮助中心首页 → dist/docs/index.html
│   │       ├── quickstart.astro    5 分钟上手
│   │       └── [...slug].astro     其余文章按 MDX 集合渲染
│   ├── content/docs/*.mdx      帮助中心八篇文章（内容集合）
│   ├── content.config.ts       内容集合 schema
│   ├── layouts/                BaseLayout（SEO/JSON-LD/页头页脚）、DocsLayout（帮助中心外壳）
│   ├── components/             Header.astro、Footer.astro
│   ├── data/
│   │   ├── jsonld/*.ts         各页结构化数据
│   │   ├── docs-nav.json       侧栏目录
│   │   └── docs-order.json     阅读顺序（上一篇 / 下一篇）
│   ├── integrations/           xml-sitemap.mjs（手写地址表，保持 .html URL）
│   ├── lib/site.ts             站点配置读取与域名占位符
│   ├── lib/track.ts            埋点小门面（脚本未加载时静默空操作）
│   ├── scripts/                main.ts（吸顶、菜单、滚动入场、审批卡）、pages.ts（目录高亮、表单兜底）
│   ├── styles/
│   │   ├── theme.css           @theme 变量，由 scripts/sync-tokens.mjs 生成
│   │   ├── legacy.css          品牌与页面样式（@layer components）
│   │   └── global.css          基础层 + 引入上面两份
│   └── site.config.json        部署期默认值（域名、应用地址、支持邮箱）
├── public/                     原样拷贝到产物根：assets/（含 analytics.js）、llms.txt、robots.txt
├── scripts/
│   ├── sync-tokens.mjs         packages/ui tokens → src/styles/theme.css
│   └── prepare-config.mjs      site.config.json → 运行时默认表
├── docker/
│   ├── start.sh                官网服务的启动脚本：渲染域名 → 托管静态文件
│   └── entrypoint.sh           域名渲染（占位符两步替换，避免串扰）
├── tests/site.test.ts          产物体检：页面齐全、SEO、JSON-LD、站内链接、sitemap
├── tests/analytics.test.ts     埋点：静默模式、属性白名单、点击委托、产物里的 CTA
├── astro.config.mjs            build.format: "file"（保留 .html 地址）
└── README.md
```

## 部署

### 容器镜像

官网**没有单独的镜像**。它是主镜像 `sjzsdu/weave-order` 里的一个服务，
靠 compose 的 `command` 选择进程 —— 和 API / Web / Admin / Mobile 同一个镜像：

```bash
# 本地构建验证（不推送）
PUSH=0 ./scripts/build_push_images.sh

# 构建并推送（CI 发版走的就是这条）
PUSH=1 TAG=v0.1.4 ./scripts/build_push_images.sh
```

以前官网是单独的 `weave-order-site` 镜像。两边用同一个 `WEAVE_TAG` 发布，
天然会「主镜像推了、官网镜像没推」—— v0.1.3 就这么炸过一次：
工作流全绿，但 compose 拉不到官网镜像，官网起不来。
并进主镜像后不存在这个中间状态：官网的产物本来就在主镜像里。

镜像里已经有的：

- `/app/apps/site/dist/` —— 构建产物（主镜像的 `pnpm build` 经 Turborepo 顺带构建）
- `/app/apps/site/docker/start.sh` —— 官网服务的启动脚本
- `/app/scripts/serve-static.mjs` —— 静态托管脚本（与移动端 PWA 共用）

deploy 侧的官网服务：

```yaml
weave-site:
  image: ${WEAVE_IMAGE_PREFIX:-sjzsdu}/weave-order:${WEAVE_TAG:-latest}
  command: ["sh", "apps/site/docker/start.sh"]
  environment:
    PORT: "80"
    WEAVE_SITE_URL: https://${WEAVE_SITE_DOMAIN:-weave.wnbgj.com}
    ...
```

刻意不用 `<<: *app` 锚点：那个锚点带 `env_file`（`.env` / `.env.secrets`），
里面是数据库口令与密钥，静态站一个都不需要。

**域名在容器启动时渲染，不在构建期写死。** 镜像里带的是 `site.config.json`
的默认值，部署环境用环境变量覆盖（与 deploy 仓库 compose 对齐）：

| 环境变量              | 对应配置项 | 用途                       |
| --------------------- | ---------- | -------------------------- |
| `WEAVE_SITE_URL`      | `site`     | 官网域名（canonical / OG） |
| `WEAVE_APP_URL`       | `app`      | 工作台地址                 |
| `WEAVE_ADMIN_URL`     | `admin`    | 平台管理入口               |
| `WEAVE_SSO_URL`       | `sso`      | 统一登录地址               |
| `WEAVE_SUPPORT_EMAIL` | `email`    | 支持邮箱（留空则沿用默认） |

`docker/start.sh` 做两件事：

1. 用镜像里的 `src/site.config.json` 生成默认表，`docker/entrypoint.sh` 把旧值换成
   占位符、再把占位符换成新值（避免「官网新值恰好等于工作台旧值」这类串扰；
   邮箱先占位，不会被域名替换顺手改掉）。渲染前先把原始产物重铺到 `/tmp/weave-site`，
   所以容器重启后换域名同样生效。
2. 用 `scripts/serve-static.mjs` 托管渲染后的产物：HTML / `sitemap.xml` / `llms.txt`
   走 `no-cache`（渲染内容随部署环境变，长缓存会把旧域名留在浏览器里），
   静态资源 30 天缓存，404 用站点自己的 `404.html`（状态码仍是 404），
   文本类型按 `Accept-Encoding` 压缩，并带 `nosniff` / `X-Frame-Options` /
   `Referrer-Policy`。

### 纯静态托管

不想用容器，也可以把 `dist/` 整个发布出去：

- **Vercel / Netlify / Cloudflare Pages**：构建命令 `pnpm --filter @weave-order/site build`，输出目录 `apps/site/dist`。
- **自有 nginx**：`root /var/www/weaveorder;`，`index.html` 设 `Cache-Control: no-cache`，静态资源长缓存，`error_page 404 /404.html;`。
- 需要国内备案域名时，记得补页脚备案号。

## 字体

默认不加载外部字体，使用系统字体栈（标题思源宋体 / 宋体系，正文 Inter / 思源黑体 / 苹方）。国内首屏不依赖境外字体 CDN。若要严格统一字形，把 Inter 与 Noto Serif SC 子集化成 woff2 放进 `public/assets/fonts/`，在 `src/styles/legacy.css` 里 `@font-face` 引入；单页实际用字约 400 字，子集通常小于 120 KB。

## 交互说明

- 首页审批卡：点「批准并发送」，虚线草稿变实线、状态变「已批准 · 已发送」，给出客户报价链接；点「改一处」金额按新价重算。全站唯一的主交互，让人 5 秒内明白产品怎么用。
- 帮助中心：左侧目录、右侧本页目录随滚动高亮；首页搜索只过滤本地卡片，不联网。
- 表单：`data-mailform` 的表单会整理成邮件并打开客户端，不做静默采集。
- 全部动效为渐进增强；禁用 JS 时内容完整可读；支持 `prefers-reduced-motion`。
- 无障碍：跳转链接、`aria-label`、`aria-current`、焦点可见、表单 `label` 关联、对比度按 WCAG AA 取值。

## 与产品前端的关系

官网是 workspace 里的 `@weave-order/site` 包，与 `apps/web`、`apps/admin` 地位平等，
共用 `packages/ui` 的品牌变量（墨、纸、靛蓝、朱砂）。改色改 `packages/ui/src/tokens.ts`
一处即可：Tailwind v4 的 `@theme`（`src/styles/theme.css`）由脚本生成，不会漏。

登录页的「申请开通」「帮助中心」「返回官网」指向 `NEXT_PUBLIC_MARKETING_URL`（见 `.env`），上线时改成正式域名即可，不需要改代码。
