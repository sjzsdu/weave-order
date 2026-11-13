# 织序 WeaveOrder · 官网

静态官网，零构建、零依赖、零后端：`index.html` + 一份 CSS + 一个 JS 文件，直接托管即可。

- 定位与口号：你说生意，系统做单。
- 页面内容与 `docs/product-design.md`（产品设计 v1.8）一致：六项能力、五步旅程、内核四条铁律、自主等级 L0 到 L3、双端分工、三档定价、六个高频问题。
- 设计语言见 `../brand/brand-guide.md`。

## 本地预览

```bash
cd site
python3 -m http.server 8080
# 打开 http://localhost:8080
```

直接用浏览器打开 `site/index.html` 也可以（相对路径全部可用）。

## 目录

```
site/
├── index.html              单页全部内容（SEO meta、OG、JSON-LD 都在头部）
├── assets/
│   ├── styles.css          全部样式（CSS 变量 + 响应式 + reduced-motion）
│   ├── main.js             吸顶、移动菜单、滚动入场、审批卡演示、表单校验
│   ├── logo-mark.svg       导航与页脚标记
│   ├── logo-horizontal.svg 横版组合
│   ├── favicon.svg         favicon（另含 icons/icon-32.png 兜底）
│   ├── og-cover.png        社交分享图 1200 × 630
│   └── icons/              iOS / PWA 图标
└── README.md
```

## 部署

任选静态托管，把 `site/` 目录整体发布即可：

- **Vercel / Netlify / Cloudflare Pages**：根目录设为 `site`，构建命令留空，输出目录 `.`。
- **自有 nginx**：`root /var/www/weaveorder;`，再对 `index.html` 设置 `Cache-Control: no-cache`，静态资源长缓存。
- 需要 `weaveorder.cn` 走备案域名时，记得补页脚备案号。

上线前请替换：

1. `index.html` 的 `<link rel="canonical">` 与 `og:image` 为**绝对地址**（如 `https://weaveorder.cn/assets/og-cover.png`），社交平台不解析相对路径。
2. 页脚联系方式与邮箱（当前为 `hello@weaveorder.cn`）。

## 待接线的三件事

| 位置 | 现在 | 建议 |
| ---- | ---- | ---- |
| 预约表单 `#demoForm` | `mailto:` 打开邮件客户端，不静默收集 | 换成你的表单服务或 `POST /api/leads`，保留 `is-sent` 提示 |
| 访问统计 | 无 | 接 Plausible / PostHog，只统计匿名页面事件 |
| CTA 转化 | 无 | 给「预约演示」「开始试用」加 `data-cta` 属性后统一埋点 |

## 字体

默认不加载外部字体，使用系统字体栈：

- 标题：`Noto Serif SC` → `Noto Serif CJK SC` → `Songti SC` → `SimSun` → Georgia
- 正文：`Inter` → `Noto Sans SC` → `PingFang SC` → `Microsoft YaHei` → system-ui
- 数字与日志：`JetBrains Mono` → `ui-monospace` → `Consolas`

这样国内首屏不依赖 Google Fonts。若需要严格统一的字形，把 Inter 与思源宋体**子集化**成 woff2 放到 `assets/fonts/`，在 `styles.css` 里用 `@font-face` 引入即可，单页实际用字约 400 个汉字，子集通常小于 120 KB。

## 交互说明

- 审批卡：点「批准并发送」，虚线草稿变实线、状态变「已批准 · 已发送」、给出客户报价链接；点「改一处」，金额按内核口径重算（演示用）。这是全站唯一的主交互，目的是让人 5 秒内明白产品怎么用。
- 滚动入场、吸顶、移动端菜单均为渐进增强，禁用 JS 时内容完整可读。
- 支持 `prefers-reduced-motion`，关闭动效后不依赖动画也能读完整页。
- 无障碍：跳转链接、`aria-label`、焦点可见、表单 `label` 关联、对比度按 WCAG AA 取值。

## 与产品前端的关系

这是独立的静态营销站，不参与 pnpm workspace，也不依赖 `apps/web` 的设计系统包。品牌变量（墨、纸、靛蓝、朱砂）与 `packages/ui/src/tokens.ts` 同源，改色时两处一起改。

若之后要并入 Next.js 主站，可把 `index.html` 拆成 `app/(marketing)/page.tsx`，CSS 直接复用 `assets/styles.css`，无需改设计。
