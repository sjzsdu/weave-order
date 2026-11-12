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

# 连真后端（默认 http://localhost:3000）
TARO_APP_MOCK=0 TARO_APP_API_BASE=http://localhost:3000 pnpm --filter @weave-order/mobile dev:live

# 产物（PWA 可安装）
pnpm --filter @weave-order/mobile build          # 生产，连真后端
TARO_APP_MOCK=1 pnpm --filter @weave-order/mobile build:demo
```

环境变量（构建期固化，页面只读 `process.env.TARO_APP_*`）：

| 变量                | 默认                    | 说明                                       |
| ------------------- | ----------------------- | ------------------------------------------ |
| `TARO_APP_MOCK`     | 空（关）                | `1` 时启用本地 mock 服务端，演示 P0 主链路 |
| `TARO_APP_API_BASE` | `http://localhost:3000` | 真后端地址                                 |

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

## 身份与隐私

- token 只驻留内存（`setAuthToken`），**不落本地明文**；冷启动重新走 OIDC 登录。
- 手机号默认脱敏；成本 / 毛利不缓存到本地；只缓存今日/待批/客户列表的只读快照。
- 大额审批二次验证：小程序走微信 Soter；RN App 走宿主注入的 `WeaveBiometrics`
  （未注入时 fail-closed）；H5 无 Face ID，退化为明确二次确认并标注验证方式。
- 色卡固定提示「屏幕色仅供参考，以实物色卡为准」。

## 目录

```
src/
├── app.tsx / app.config.ts       # 5 Tab + 2 二级页；PWA、离线恢复
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

| 调用                                                | 当前状态     | 说明                                                                                                              |
| --------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `POST /api/revisions`、`POST /api/revisions/decide` | mock 已实现  | 输入用 T0 的 `CreateRevisionRequestInput` / `DecideRevisionRequestInput`；HTTP 路径待 Track A 确认                |
| `GET /api/quotes/:id`                               | mock 已实现  | 返回 `{ draft, version, status }`，供改价页 / 冲突重载                                                            |
| `POST /api/media/presign`                           | mock 已实现  | 返回 `{ uploadUrl, publicUrl, method, headers?, formData? }`                                                      |
| `POST /api/shipments/proof`                         | mock 已实现  | 拍照签收 / 大货 / 回款凭证                                                                                        |
| `GET /api/quote-shares?quoteId=`                    | mock 已实现  | 客户 360 的链接访问时间线                                                                                         |
| `POST /api/tools/search-by-image`                   | **契约冲突** | T0 的 T-001 只接受 base64 `image`，与「禁止 base64 JSON」冲突；移动端改为直传后传 `imageUrl`，需契约增加 URL 变体 |

切换真后端只需改 `src/lib/mobile-api.ts`（未冻结点集中在这里），页面不裸 fetch。

## 测试

```bash
pnpm --filter @weave-order/mobile test      # 19 个用例：解析 / 图片预算 / 角色 / P0 链路 / 冲突重试
pnpm --filter @weave-order/mobile typecheck
pnpm --filter @weave-order/mobile lint
```
