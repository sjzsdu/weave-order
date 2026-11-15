# apps/mobile · 租户端移动（E2，Taro）

一套代码输出 H5/PWA（P0）与小程序 / RN App（P3）。底部 5 入口：今日 / 审批 / 相机 / 客户 / 更多；
二级页：快速报价（`pages/quote`）、客户 360（`pages/customer`）。

## 本地运行

```bash
pnpm install
pnpm --filter @weave-order/schema build
pnpm --filter @weave-order/core build

# 演示模式：契约端点本地 mock，无需后端（H5 dev server: http://localhost:10086）
pnpm --filter @weave-order/mobile dev

# 或从仓库根一条命令起全部端（含移动端，最后统一打印地址清单）
pnpm dev

# 连真后端（默认 http://localhost:3000）
TARO_APP_MOCK=0 TARO_APP_API_BASE=http://localhost:3000 pnpm --filter @weave-order/mobile dev:live

# 产物（PWA 可安装）
pnpm --filter @weave-order/mobile build          # 生产，连真后端（末尾自动跑 mock 门禁）
TARO_APP_MOCK=1 pnpm --filter @weave-order/mobile build:demo   # 演示产物，禁止交付
```

环境变量（构建期固化，页面只读 `process.env.TARO_APP_*`）：

| 变量                | 默认                    | 说明                                       |
| ------------------- | ----------------------- | ------------------------------------------ |
| `TARO_APP_MOCK`     | 空（关）                | `1` 时启用本地 mock 服务端，演示 P0 主链路 |
| `TARO_APP_API_BASE` | `http://localhost:3000` | 真后端地址                                 |

### mock 门禁（生产构建硬约束）

mock 服务端是**无鉴权的演示数据**，误把演示产物交付等于泄露演示租户数据。因此：

- `NODE_ENV=production` 时 `IS_MOCK` 编译期恒为 `false`（`src/lib/runtime.ts`），mock 模块用
  `require` 包在字面量条件里，webpack 会把整个分支连同 `src/lib/mock/**` 一起摘掉；
- `pnpm build` / `pnpm build:weapp` 末尾自动执行 `node scripts/check-prod-bundle.mjs`，
  产物里出现 mock 种子特征串（`MOCK_TENANT_ID`、`weave.mock.state`、演示单据）就判红；
- `pnpm verify:mock-gate` 自检门禁本身：先构建一份带 mock 的产物，断言检查脚本确实报错。

手动验证生产产物：

```bash
pnpm --filter @weave-order/mobile build
grep -rl "00000000-0000-4000-8000-000000000001" apps/mobile/dist/js || echo "无 mock 代码 ✓"
```

`build:demo` 强制 `NODE_ENV=development`，产物体积与 React 开发警告都说明它是演示包，不是发布包。

## P0 主链路（可演示）

「手机粘贴客户原话 → 改一个价 → 批准 → 分享报价链接」：

1. 今日 → 快捷动作「粘贴微信」/「快速报价」。
2. 粘贴原话，点「解析原话」：本地确定性解析出客户、成分、克重、数量、目标价；
   命中项与缺失项都显示成徽标，数量 / 客户可改。
3. 「找样」调用 `POST /api/tools/search-by-spec`（T-002），候选必须带命中理由。
4. 「用这个面料生成草稿」调用 `POST /api/tools/generate-quote-draft`（T-004）；
   金额一律由服务端（mock 同契约）计算，前端不自己算价。
5. 草稿卡里改单价 → `POST /api/revisions` + `POST /api/revisions/decide`（带 `baseVersion`）；
   服务端版本已变时返回 409，前端弹「保留哪一版」，绝不静默覆盖。
6. 「批准报价」→ `POST /api/approvals/decide`（HUMAN 上下文；大额走二次验证）。
7. 批准后「生成分享链接」→ `POST /api/quote-shares`；链接与 token 只在生成时出现一次，
   不落本地明文；「接受 ≠ 合同」提示固定展示。

Mock 模式下可在「更多 → 演示模式」里模拟断网与「服务端已被另一端改价」，用来演练离线队列与冲突处理。

## 离线队列

- H5：IndexedDB（`weave-offline`）；小程序 / App：`Taro.setStorageSync`。
- 入队操作：`quote.compose`（原话→草稿）、`quote.revise`（改价）、`quote.decide`（批/驳回）、
  `shipment.proof`（拍照回传）。
- 恢复联网 / 启动时按入队时间序提交；普通网络失败停止，保持时间序；版本冲突标记为 `conflict` 并停止该条，
  在「更多 → 离线队列」里人工选择「保留服务端」或「以服务端版本重试」。
- 分享链接不排队：链接必须由服务端签发，离线时不生成、不把 token 存本地。

## 媒体

- 压缩：长边 ≤ 1600px、体积 ≤ 1MB（H5 canvas / 小程序离屏 canvas + `compressImage`）。
- 直传：先 `POST /api/media/presign` 拿预签名 URL，再用 PUT/POST 直传对象存储；
  **任何图片都不进 JSON base64**。
- 离线照片：H5 把 Blob 存 IndexedDB，小程序 `Taro.saveFile` 持久化；队列只存 `mediaKey`，
  恢复后上传并调用 `POST /api/shipments/proof`。

## PWA

`src/index.html` + `src/pwa/manifest.json` + `src/pwa/sw.js`（构建时复制到 dist 根目录）。
`initPwa()` 在 H5 注册 Service Worker；只缓存静态壳，不缓存 `/api` 鉴权响应。
安装提示由 `beforeinstallprompt` 驱动，「更多」里提供安装入口（HTTPS 或 localhost 满足安装条件）。

## Tab 图标

底部 5 个 Tab 的图标不在 `app.config.ts` 里手写路径以外的东西——那里只写相对 `src/` 的路径：

```ts
{ pagePath: "pages/today/index", text: "今日",
  iconPath: "assets/tab/today.png", selectedIconPath: "assets/tab/today-active.png" }
```

**少了 `iconPath` 的代价**：Taro H5 的 `taro-tabbar` 组件无条件渲染
`<img class="weui-tabbar__icon">`，`src` 为空就是一个 27×27 的空框（小程序端退化成纯文字）。
所以图标路径不是可选项。

图标本身是生成物，不要手改 PNG：

```bash
pnpm --filter @weave-order/mobile build:tabbar-icons
```

母版在 `assets/tabbar/*.svg`（24×24 描边，`currentColor` 取色），
脚本渲染成 `src/assets/tab/<name>.png` 与 `<name>-active.png`（81×81，透明底）。
普通态 `#5f646d`、选中态 `#1f6f5c`，与 `app.scss` 的 `$muted` / `$accent` 及
`app.config.ts` 的 `tabBar.color` / `selectedColor` 对齐。

同一份 PNG 两端通用：H5 由 taro-loader 当 asset 打包（体积小会内联成 data URI），
小程序由 MiniPlugin 原样拷到包根 `assets/tab/`。

## 身份与隐私

- **H5/PWA 登录（生产）**：托管层用 `scripts/serve-static.mjs --runtime-config` 把
  `window.__WEAVE_CONFIG__` 注入 `index.html`（`WEAVE_API_BASE` / `WEAVE_MOBILE_URL` /
  `CASDOOR_ISSUER` / `CASDOOR_CLIENT_ID`）。`src/lib/oidc.ts` 实现 Authorization Code + PKCE：
  启动时未登录直接跳 Casdoor，回调 `/auth/callback` 用 `code_verifier` 换 token
  （**前端不持有 client_secret**），业务请求 401 自动回登录；回调失败不自动重跳，
  避免「授权失败 → 再授权」死循环。Service Worker 明确跳过 `/auth/`，不缓存授权码。
- **没有注入配置时不启用门禁**：本地 dev / 演示包 / 小程序 / RN 保持原有行为，
  不会被强制跳登录。换域名只改部署环境变量，不用重发镜像。
- **Casdoor 前提**：`app-weave-order` 的 redirectUris 必须含
  `https://<移动端域名>/auth/callback`，且应用要允许 public PKCE（不带 `client_secret`
  的 code 交换）。若换 token 报 `invalid_client` / 要求 secret，需在 Casdoor 侧开启
  public PKCE，或改走服务端 BFF 换 token（另一种架构，见 deploy README）。
- token 只驻留内存（`src/lib/session.ts` 的 `setAuthToken`），**不落本地明文**；
  PKCE 的 state / verifier 暂存在 sessionStorage（不是令牌），回调后立即删除。
- 手机号默认脱敏；成本 / 毛利不缓存到本地；只缓存今日/待批/客户列表的只读快照。
- **已知缺口**：`@weave-order/core` 的 `mock-client` 演示数据会被打进生产包
  （CJS `export *` 无法 tree-shake），但 `IS_MOCK` 编译期恒为 false、运行时不执行。
  `scripts/check-prod-bundle.mjs` 的 SENTINELS 只覆盖 `src/lib/mock/**`，暂未拦截这处死代码。
- 大额审批二次验证：小程序走微信 Soter；RN App 走宿主注入的 `WeaveBiometrics`
  （未注入时 fail-closed）；H5 无 Face ID，退化为明确二次确认并标注验证方式。
- 色卡固定提示「屏幕色仅供参考，以实物色卡为准」。

## 目录

```
src/
├── app.tsx / app.config.ts       # 5 Tab + 2 二级页；PWA、离线恢复
├── assets/tab/                    # Tab 图标 PNG（生成物，母版在 ../../assets/tabbar）
├── components/                   # 移动端基础组件（Taro 原生组件，不复用 DOM）
├── lib/
│   ├── runtime.ts                # 唯一组合根：mock / 真后端 / 队列 / 偏好
│   ├── mobile-api.ts             # core 契约客户端 + revisions / presign / proof
│   ├── hooks.ts                  # TanStack Query + 只读缓存 + 网络状态
│   ├── offline.ts                # IndexedDB / Taro Storage 队列与提交
│   ├── media.ts / image-math.ts  # 压缩、直传、离线照片
│   ├── parse-customer-text.ts    # 客户原话 → 槽位（可解释，纯函数）
│   ├── recorder.ts               # 语音批注（H5 MediaRecorder/Web Speech，小程序 RecorderManager）
│   ├── biometric.ts              # 大额审批二次验证（TARO_ENV 分支集中在这里）
│   └── mock/                     # 同契约的本地 mock 服务端（仅演示）
└── pages/                        # today / approvals / camera / customers / more / quote / customer
```

## 待联调契约（Track A / E 落地后对齐）

| 调用                                                | 当前状态      | 说明                                                                                                             |
| --------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `POST /api/revisions`、`POST /api/revisions/decide` | mock 已实现   | 输入用 T0 的 `CreateRevisionRequestInput` / `DecideRevisionRequestInput`；HTTP 路径待 Track A 确认               |
| `GET /api/quotes/:id`                               | 真后端已对齐  | 共用契约 `QuoteDetail`：`{ draft, version, status }`，批准后 `status` 离开 `DRAFT`；供改价页 / 冲突重载          |
| `POST /api/media/presign`                           | mock 已实现   | 返回 `{ uploadUrl, publicUrl, method, headers?, formData? }`                                                     |
| `POST /api/shipments/proof`                         | mock 已实现   | 拍照签收 / 大货 / 回款凭证                                                                                       |
| `GET /api/quote-shares?quoteId=`                    | mock 已实现   | 客户 360 的链接访问时间线                                                                                        |
| `POST /api/tools/search-by-image`                   | 已补 URL 变体 | T-001 现接受 `imageUrl`（与 base64 `image` 二选一）；服务端按 `MEDIA_ALLOWED_HOSTS` 白名单取图，移动端直传后调用 |

切换真后端只需改 `src/lib/mobile-api.ts`（未冻结点集中在这里），页面不裸 fetch。

真后端启用 imageUrl 变体需配置对象存储域名白名单：`MEDIA_ALLOWED_HOSTS=cdn.weaveorder.cn`（本地 MinIO 可加 `localhost`）。

## 测试

```bash
pnpm --filter @weave-order/mobile test      # 19 个用例：解析 / 图片预算 / 角色 / P0 链路 / 冲突重试
pnpm --filter @weave-order/mobile typecheck
pnpm --filter @weave-order/mobile lint
```
