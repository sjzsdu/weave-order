# 织序 WeaveOrder · 官网与帮助中心

静态站点，零构建、零依赖、零后端：托管目录即可上线。唯一需要 Node 的地方是 `tools/build-docs.mjs`（维护帮助中心文章时用，产物已提交）。

## 现在有哪些页面

| 路径                                                                     | 作用                                                                | 谁维护                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------- |
| `index.html`                                                             | 首页：定位、能力、五步链路、规则与留痕、双端、价格、FAQ、预约演示   | 手工                               |
| `pricing.html`                                                           | 价格、计费口径、发票与套餐变更、购买前的问题                        | 手工                               |
| `signup.html`                                                            | 免费试用 / 开通：三步旅程、登记表单、开通前准备、常见问题           | 手工                               |
| `download.html`                                                          | 下载：网页版、Windows / macOS、手机 PWA、打印代理、命令行、运行环境 | 手工                               |
| `login.html`                                                             | 登录入口：工作台、平台管理、忘记密码、四类登录问题                  | 手工                               |
| `legal.html`                                                             | 服务条款与隐私政策（可读版）                                        | 手工                               |
| `docs/index.html`                                                        | 帮助中心首页：按任务分类 + 搜索 + 十个高频问题                      | 手工                               |
| `docs/quickstart.html`                                                   | 5 分钟上手                                                          | 手工                               |
| `docs/{signup,import,approvals,quotes,printing,agent,security,faq}.html` | 七篇操作文档与 FAQ                                                  | **由 `tools/build-docs.mjs` 生成** |
| `404.html`                                                               | 找不到页面时的四个出口                                              | 手工                               |
| `llms.txt`                                                               | 给 AI 助手（ChatGPT / Claude / Perplexity 等）的产品摘要与事实清单  | 手工                               |
| `robots.txt` / `sitemap.xml`                                             | 抓取规则与站点地图                                                  | 手工                               |

导航与页脚在所有页面里保持一致，改一处要改全站（`grep -rl` 即可）。

## 本地预览

```bash
cd site
python3 -m http.server 8080
# 打开 http://localhost:8080
```

直接双击 `index.html` 也能看，相对路径全部可用。

## 改帮助文档

文章页共用同一套外壳（页头、侧栏、目录、上下篇、结构化数据）。不要直接改 `docs/import.html` 这类文件，改 `tools/build-docs.mjs` 里的 `pages` 数组再生成：

```bash
node site/tools/build-docs.mjs   # 覆盖生成 8 篇文章页
```

新增一篇文章：在 `pages` 里加一项（`slug`、`title`、`description`、`lede`、`sections`），再把它加进 `SIDE` 导航与 `ORDER`（上下篇顺序），最后补 `sitemap.xml`。

## SEO 与「大模型搜索」优化

搜索引擎部分：

- 每页都有唯一的 `<title>`、`meta description`、`canonical`、Open Graph 与 Twitter Card；`og:image` 用绝对地址。
- 结构化数据：首页 `Organization` + `WebSite` + `SoftwareApplication` + `FAQPage`；价格页 `Product` + `Offer`；开通页 `HowTo`；文档页 `BreadcrumbList`；FAQ 页 `FAQPage`。
- `sitemap.xml` 含全部 15 个可索引页面；`robots.txt` 声明 sitemap，并显式允许 GPTBot / ClaudeBot / PerplexityBot。
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

页面里所有绝对地址都来自 `site/site.config.json`。换域名不改 17 个文件，只跑一条命令：

```bash
# 只换官网域名
node site/tools/configure.mjs --site https://weave.example.com

# 官网、应用、管理端、统一登录、支持邮箱一起换
node site/tools/configure.mjs \
  --site https://weave.example.com \
  --app https://app.example.com \
  --admin https://admin.example.com \
  --sso https://sso.example.com \
  --email ops@example.com

# 先看会改哪些文件、多少处，不落盘
node site/tools/configure.mjs --site https://weave.example.com --dry-run
```

脚本做的事：把旧值全站替换成新值（canonical、OG、JSON-LD、sitemap、`llms.txt`、站内链接、正文里出现的裸域名），然后写回 `site.config.json`。可重复执行，第二次会告诉你「配置没有变化」。帮助中心的生成器也读这份配置，重新生成文档不会把域名重置回占位值。

当前占位值（部署时按实际环境覆盖）：

| 配置项  | 当前值                          | 用途                         |
| ------- | ------------------------------- | ---------------------------- |
| `site`  | `https://weaveorder.cn`         | canonical、OG、sitemap、llms |
| `app`   | `https://weave.wnbgj.com`       | 登录 / 打开工作台            |
| `admin` | `https://weave-admin.wnbgj.com` | 平台管理入口                 |
| `sso`   | `https://sso.wnbgj.com`         | 忘记密码、统一登录           |
| `email` | `hello@weaveorder.cn`           | 咨询、开通、账单             |

仍有三件不在这个脚本范围内：

1. **应用侧两个环境变量**：`apps/web` 的 `NEXT_PUBLIC_MARKETING_URL`（登录页指向官网）与 `NEXT_PUBLIC_SUPPORT_EMAIL`；统一登录地址直接复用 `CASDOOR_ISSUER`。
2. **Casdoor 应用回调**：`weave-order-web` 的 redirect URI 必须包含 `<应用域名>/auth/callback`。应用本身不要求固定域名：没设 `PUBLIC_APP_URL` 时按请求来源推导。
3. **备案号**：若部署在国内服务器，页脚需要补 ICP 备案号与公安备案号。

## 开通链接：现在怎么走

`signup.html` 的承诺与代码一致：**登记 → 人工确认 → 发一条开通链接 → 客户自己点开完成开通**。

- 控制面（`apps/platform-api`）：管理员在租户详情页点「生成开通链接」，接口 `POST /platform/api/tenants/:id/onboarding-link` 用 `ONBOARDING_SECRET` 签一条 7 天有效的票据，返回 `<WEB_APP_URL>/activate?code=...`。
- 租户端（`apps/web` / `apps/api`）：`/activate` 先展示公司名与登记邮箱，客户登录后 `POST /api/onboarding/claim` 验签、核对邮箱，然后建出业务库租户 + 老板成员（`OWNER` / `ALL`）。重复点击幂等。
- 不需要在 Casdoor 建 Organization：登录身份按 `sub` 解析，`casdoorOrg` 可为空。
- 两张库靠 `slug` 对齐：控制面租户的 slug 与业务库租户的 slug 相同。

仍然缺的一环是**完全开放的自助注册**（不经过人工审核、不依赖链接）：那需要在官网收表后自动落一条待办、自动信用风控与限流，并把开通链接自动发出去。在此之前，官网不写「立即注册」，只写「登记后当天发链接」——这是当前真实能做到的。

## 目录

## 目录

```
site/
├── index.html / pricing.html / signup.html / download.html / login.html / legal.html / 404.html
├── docs/
│   ├── index.html / quickstart.html       手工维护
│   └── signup.html … faq.html             脚本生成
├── assets/
│   ├── styles.css        品牌与首页样式（CSS 变量 + 响应式 + reduced-motion）
│   ├── pages.css         站内页面：价格 / 下载 / 登录 / 开通 / 帮助中心
│   ├── main.js           吸顶、移动菜单、滚动入场、审批卡演示
│   ├── pages.js          目录高亮、系统识别、表单邮件兜底
│   ├── logo-*.svg        品牌标识
│   ├── og-cover.png      社交分享图 1200 × 630
│   └── icons/            iOS / PWA 图标
├── site.config.json      部署期配置：域名、应用地址、支持邮箱
├── tools/
│   ├── build-docs.mjs    帮助中心文章生成器（开发期使用）
│   └── configure.mjs     部署时把配置写进全站（换域名一条命令）
├── llms.txt / robots.txt / sitemap.xml
└── README.md
```

## 部署

任选静态托管，把 `site/` 整体发布即可：

- **Vercel / Netlify / Cloudflare Pages**：根目录 `site`，构建命令留空，输出目录 `.`。
- **自有 nginx**：`root /var/www/weaveorder;`，`index.html` 设 `Cache-Control: no-cache`，静态资源长缓存，`error_page 404 /404.html;`。
- 需要国内备案域名时，记得补页脚备案号。

## 字体

默认不加载外部字体，使用系统字体栈（标题思源宋体 / 宋体系，正文 Inter / 思源黑体 / 苹方）。国内首屏不依赖境外字体 CDN。若要严格统一字形，把 Inter 与 Noto Serif SC 子集化成 woff2 放进 `assets/fonts/`，在 `styles.css` 里 `@font-face` 引入；单页实际用字约 400 字，子集通常小于 120 KB。

## 交互说明

- 首页审批卡：点「批准并发送」，虚线草稿变实线、状态变「已批准 · 已发送」，给出客户报价链接；点「改一处」金额按新价重算。全站唯一的主交互，让人 5 秒内明白产品怎么用。
- 帮助中心：左侧目录、右侧本页目录随滚动高亮；首页搜索只过滤本地卡片，不联网。
- 表单：`data-mailform` 的表单会整理成邮件并打开客户端，不做静默采集。
- 全部动效为渐进增强；禁用 JS 时内容完整可读；支持 `prefers-reduced-motion`。
- 无障碍：跳转链接、`aria-label`、`aria-current`、焦点可见、表单 `label` 关联、对比度按 WCAG AA 取值。

## 与产品前端的关系

这是独立的静态营销站，不参与 pnpm workspace。品牌变量（墨、纸、靛蓝、朱砂）与 `packages/ui/src/tokens.ts` 同源，改色时两处一起改。

登录页的「申请开通」「帮助中心」「返回官网」指向 `NEXT_PUBLIC_MARKETING_URL`（见 `.env.example`），上线时改成正式域名即可，不需要改代码。
