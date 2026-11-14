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
| `guides/{textile-erp-selection,fabric-quotation-software,sample-follow-up,textile-reconciliation}.html` | 四篇长尾搜索意图指南：选型、报价、寄样、对账 | `src/content/guides/*.mdx` |
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
pnpm --filter @weave-order/site test    # 构建 + 产物体检（页面、SEO、链接、sitemap）
```

`build` 会先跑 `scripts/sync-tokens.mjs`：从 `packages/ui/src/tokens.ts` 生成
`src/styles/theme.css`（Tailwind v4 的 `@theme` 变量）。所以改品牌色只改
`packages/ui` 一处，站点和其它应用同步。

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
（侧栏）与 `src/data/docs-order.json`（阅读顺序），最后补 `src/integrations/xml-sitemap.ts`
里的地址表 —— `pnpm --filter @weave-order/site test` 会检查这三处是否一致。

## 改长尾指南

`/guides/*.html` 是四篇搜索落地页，回答的是客户在搜索引擎里打的那句话
（「纺织 ERP 怎么选」「寄样怎么跟进」），和帮助中心「这个按钮在哪」的定位不同。

正文是 MDX（`src/content/guides/*.mdx`），外壳与结构化数据都在
`src/layouts/GuidesLayout.astro` + `src/pages/guides/[...slug].astro` 里：

```mdx
---
title: "寄样跟进 SOP：…… · 织序"      # 浏览器标题
description: "……"                     # meta description
h1: "寄样总是漏跟？……"                 # 正文大标题（与 title 不同）
lede: "……"                            # 第一段，直接回答问题，可被单独摘出引用
file: "sample-follow-up.html"
order: 3                              # 侧栏顺序与上一篇 / 下一篇
kicker: "寄样"                         # eyebrow 里的栏目词
navLabel: "寄样跟进 SOP"               # 侧栏、上下篇、CTA 埋点用的短名
crumb: "寄样跟进指南"                   # 面包屑末项
ogDescription: "……"
aside:                                 # 页头右侧的三个数字
  - label: "5 步"
    value: "每步都有到期时间"
sections:                              # 右侧本页目录
  - id: "steps"
    heading: "五步 SOP：每一步都有到期时间"
    toc: "五步 SOP"                    # 可选：目录里的短标题
cta:                                   # 正文末尾的行动区
  title: "让待办替你记着每一步"
  text: "……"
faq:                                   # 既渲染成可见问答块，也生成 FAQPage
  - q: "寄样后多久跟进一次比较合适？"
    a: "……"
howTo:                                 # 可选：流程类指南生成 HowTo
  name: "寄样跟进的 5 步 SOP"
  description: "……"
  totalTime: "P7D"
  steps:
    - name: "登记寄样"
      text: "……"
---

<h2 id="steps">五步 SOP：每一步都有到期时间</h2>

<p>正文……</p>
```

结构化数据（BreadcrumbList / FAQPage / HowTo）由 `src/lib/guides.ts` 从 frontmatter 生成，
不手写 —— 否则改了 FAQ 措辞，结构化数据里还是旧的。新增一篇指南要做三件事：
加 `.mdx`、在 `src/integrations/xml-sitemap.ts` 补地址、在 `public/llms.txt` 的
「指南」分组补一条；`pnpm --filter @weave-order/site test` 会检查后两处。

## SEO 与「大模型搜索」优化

搜索引擎部分：

- 每页都有唯一的 `<title>`、`meta description`、`canonical`、Open Graph 与 Twitter Card；`og:image` 用绝对地址。
- 结构化数据：首页 `Organization` + `WebSite` + `SoftwareApplication` + `FAQPage`；价格页 `Product` + `Offer`；开通页 `HowTo`；文档页 `BreadcrumbList`；FAQ 页 `FAQPage`；指南页 `BreadcrumbList` + `FAQPage`（寄样与对账两篇另带 `HowTo`）。
- `sitemap.xml` 含全部 20 个可索引页面；`robots.txt` 声明 sitemap，并显式允许 GPTBot / ClaudeBot / PerplexityBot。
- 语义结构：每页一个 `h1`，章节用 `h2/h3`，正文用短段落与列表；`alt` 全部填写或显式留空。
- 登录后的工作台与平台管理端在应用层设置了 `noindex`，不参与索引。

大模型搜索（AEO / GEO）部分：

- `llms.txt` 放在站点根目录，按 [llmstxt.org](https://llmstxt.org) 的格式给出：一句话定义、关键事实（入口、价格、试用、开通方式、部署形态、身份、安全）、分主题链接、可直接引用的问答对。首页 `<head>` 里有 `<link rel="alternate" type="text/plain" href="/llms.txt">`。
- 每个页面开头先给结论，再给细节；FAQ 每条答案都能独立被摘出来（「不」开头也是完整句子）。
- 事实一致：同一组数字（299 / 499 / 14 天 / 5% / 1 万元）在首页、价格页、帮助中心、`llms.txt` 里保持一致，避免模型引用到互相矛盾的版本。
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
│   │   ├── guides/[...slug].astro  指南页：按 guides 集合渲染 → dist/guides/*.html
│   │   ├── pricing.astro / signup.astro / download.astro / login.astro / legal.astro
│   │   ├── 404.astro
│   │   └── docs/
│   │       ├── index/index.astro   帮助中心首页 → dist/docs/index.html
│   │       ├── quickstart.astro    5 分钟上手
│   │       └── [...slug].astro     其余文章按 MDX 集合渲染
│   ├── content/docs/*.mdx      帮助中心八篇文章（内容集合）
│   ├── content/guides/*.mdx    四篇长尾搜索意图指南（内容集合）
│   ├── content.config.ts       内容集合 schema
│   ├── layouts/                BaseLayout（SEO/JSON-LD/页头页脚）、DocsLayout（帮助中心外壳）、GuidesLayout（指南外壳）
│   ├── components/             Header.astro、Footer.astro
│   ├── data/
│   │   ├── jsonld/*.ts         各页结构化数据
│   │   ├── docs-nav.json       侧栏目录
│   │   ├── docs-order.json     阅读顺序（上一篇 / 下一篇）
│   │   └── guides-nav.json     指南页侧栏的「相关页面」
│   ├── integrations/           xml-sitemap.mjs（手写地址表，保持 .html URL）
│   ├── lib/site.ts             站点配置读取与域名占位符
│   ├── lib/guides.ts           指南页结构化数据（Breadcrumb / FAQPage / HowTo）
│   ├── scripts/                main.ts（吸顶、菜单、滚动入场、审批卡）、pages.ts（目录高亮、表单兜底）
│   ├── styles/
│   │   ├── theme.css           @theme 变量，由 scripts/sync-tokens.mjs 生成
│   │   ├── legacy.css          品牌与页面样式（@layer components）
│   │   ├── guides.css          指南页样式补丁（正文按钮、手机端目录、窄屏表格）
│   │   └── global.css          基础层 + 引入上面三份
│   └── site.config.json        部署期默认值（域名、应用地址、支持邮箱）
├── public/                     原样拷贝到产物根：assets/、llms.txt、robots.txt
├── scripts/
│   ├── sync-tokens.mjs         packages/ui tokens → src/styles/theme.css
│   └── prepare-config.mjs      site.config.json → 运行时默认表
├── docker/
│   ├── start.sh                官网服务的启动脚本：渲染域名 → 托管静态文件
│   └── entrypoint.sh           域名渲染（占位符两步替换，避免串扰）
├── tests/site.test.ts          产物体检：页面齐全、SEO、JSON-LD、站内链接、sitemap、指南页验收
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

登录页的「申请开通」「帮助中心」「返回官网」指向 `NEXT_PUBLIC_MARKETING_URL`（见 `.env.example`），上线时改成正式域名即可，不需要改代码。
