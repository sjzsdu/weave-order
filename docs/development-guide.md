# 织序 WeaveOrder · 目录结构规划与各端架构约束

> 版本：v1.0 ｜ 日期：2026-11-12 ｜ 作者：鲁班（首席架构师）
> 依据：`docs/architecture-and-tech-stack.md`（v1.3）与 `docs/product-design.md`（v1.8）。
> 用途：给开发人员的落地规范——每个端住在哪、能做什么、不能做什么、依赖方向是什么。**本文是编码铁律，违反即返工。**

---

## 0. 三条总原则

1. **一个产品一个仓库**：monorepo（pnpm workspace + Turborepo），不拆多仓。
2. **依赖单向**：`apps/*` → `packages/*`；`packages/*` 之间只允许 schema/shared 被其他包依赖；**禁止 packages 反向依赖 apps，禁止循环依赖**。
3. **确定性内核是唯一账本写入口**：业务数据只经内核写入；智能体只调工具层；前端只读展示 + 发起审批，绝不直接写库。

---

## 1. 端 → 位置映射

| 端                  | 形态                             | 代码位置                               | 运行/构建                        |
| ------------------- | -------------------------------- | -------------------------------------- | -------------------------------- |
| E1 租户端 · 桌面    | 浏览器 Web（+ P3 Tauri 壳）      | `apps/web`                             | Next.js 15                       |
| E2 租户端 · 移动    | Taro（H5/PWA + 小程序 + RN App） | `apps/mobile`                          | Taro                             |
| E3 客户报价链接页   | 无登录只读页面                   | `apps/quote` 的公开路由组 `/s/[token]` | Next.js 15（独立应用，隔离部署） |
| E4 平台总管理端     | 独立 Web 应用                    | `apps/admin`                           | Next.js 15                       |
| E5 打印代理         | 本地常驻桌面程序                 | `apps/print-agent`                     | Tauri 2（Rust）                  |
| E1 桌面外设壳（P3） | Tauri 壳加载 Web                 | `apps/desktop`                         | Tauri 2（Rust）                  |
| 后端内核            | NestJS 模块化单体                | `apps/api`                             | NestJS                           |

**共享包**：

| 包                | 内容                                                         | 被谁用               |
| ----------------- | ------------------------------------------------------------ | -------------------- |
| `packages/schema` | Zod 契约（工具/内核/HTTP/env 唯一来源）                      | 全部                 |
| `packages/shared` | 纯 TS 工具、常量、类型                                       | 全部                 |
| `packages/db`     | Drizzle schema + 迁移 + RLS 策略                             | `apps/api`           |
| `packages/core`   | 前端业务逻辑（TanStack Query hooks / API client / 离线队列） | web / mobile / admin |
| `packages/ui`     | 设计系统（shadcn/ui + Tailwind tokens，桌面+admin）          | web / admin          |

---

## 2. 目录结构总览

```
weave-order/
├── apps/
│   ├── api/                        # 后端内核（NestJS 模块化单体，唯一写入口）
│   │   ├── src/
│   │   │   ├── kernel/             # 确定性内核：业务表唯一写入口 + 同事务审计
│   │   │   ├── tools/              # 工具层：agent 唯一可调入口（Zod 校验）
│   │   │   ├── agents/             # 智能体编排（LangGraph.js，只调 tools）
│   │   │   ├── approval/           # 审批 / 草稿 / 修订（diff · Patch · 阈值 · 出处）
│   │   │   ├── print/              # 打印中心：模板 / 队列 / 渲染（HTML→PDF / ZPL/TSPL）
│   │   │   ├── billing/            # 计量 / 订阅 / 权益（usage_events · entitlements）
│   │   │   ├── platform/           # 配置中心 / 功能开关 / LLM settings
│   │   │   ├── gateway/            # 鉴权 + 租户上下文注入 + RLS SET LOCAL
│   │   │   └── main.ts             # 组合根：显式装配依赖，模块间不互 import 内部实现
│   │   └── test/                   # 内核集成 / HTTP e2e / 跨租户越权测试
│   ├── web/                        # E1 桌面（Vite SPA，迁 Next.js 中）
│   │   ├── app/
│   │   │   ├── (desktop)/          # 桌面路由组：today / approvals / panorama / settings
│   │   │   └── auth/callback/      # Casdoor OIDC 回调
│   │   └── src/                    # 组件 / hooks（走 packages/core）
│   ├── quote/                      # E3 客户报价页（Next.js 15 独立应用，/s/[token]）
│   ├── admin/                      # E4 平台总管理端（Next.js 15 独立应用）
│   ├── mobile/                     # E2 移动端（Taro：H5/PWA + 小程序 + RN App）
│   │   └── src/pages/              # 今日 / 审批 / 相机 / 客户 / 更多
│   ├── print-agent/                # E5 打印代理（Tauri 2 + Rust）
│   │   ├── src-tauri/              # Rust：WSS 出站 / 打印驱动 / spool / 自动更新
│   │   └── src/                    # WebView UI（配置/队列/设备）
│   └── desktop/                    # E1 桌面外设壳（P3，Tauri 2 加载 apps/web）
│       └── src-tauri/              # 只暴露 print/scan/readFile/电子秤 IPC
├── packages/
│   ├── schema/                     # Zod 契约（前后端/工具/内核唯一来源）
│   ├── shared/                     # 纯 TS 工具/常量/类型
│   ├── db/                         # Drizzle schema + 迁移 + RLS 策略
│   ├── core/                       # 前端业务逻辑（hooks / API client / 离线队列）
│   └── ui/                         # 设计系统（shadcn/ui + Tailwind tokens）
├── infra/                          # Docker Compose / 腾讯云部署 / CI / LiteLLM 配置
├── docs/                           # product-design / architecture / 本文
├── docker-compose.yml              # PostgreSQL(pgvector) + Redis（本地开发）
├── turbo.json
└── pnpm-workspace.yaml
```

---

## 3. 全局铁律（所有端遵守）

| #   | 铁律                 | 说明                                                                                             |
| --- | -------------------- | ------------------------------------------------------------------------------------------------ |
| G1  | 内核是唯一写入口     | 业务数据（客户/样品/报价/订单/应收…）只经 `apps/api/src/kernel` 写入；前端和 agent 都不得绕过    |
| G2  | Agent 只调工具层     | 智能体只能调 `tools/`，不得直接操作数据库、不得直连 LLM 厂商                                     |
| G3  | 不信任前端           | 金额、阈值、角色、数据范围一律服务端校验；前端只读展示                                           |
| G4  | 租户上下文由网关注入 | 前端不传 `tenant_id`；网关按 `(sub, org)` 解析 membership 注入，事务内 `SET LOCAL app.tenant_id` |
| G5  | Zod 是唯一契约来源   | 工具输入输出、HTTP 请求响应、环境变量都从 `packages/schema` 取，禁止手写重复类型                 |
| G6  | 金额用整数（分）     | 内核用整数计算金额，禁止浮点；展示层再格式化                                                     |
| G7  | 审计只追加           | 所有写动作同事务写 `audit_log`（actorRole/tenantId/dataScope 落快照），审计不可改                |
| G8  | 依赖方向单向         | `apps → packages`，禁止反向与循环依赖（Turborepo 边界 + ESLint no-restricted-imports 强制）      |
| G9  | 敏感字段脱敏         | 手机号、银行账号出网/进 LLM 前脱敏；成本底线、合同价、客户名单默认不进外部模型                   |
| G10 | 草稿即默认           | 所有 AI 产出为 `DRAFT`，批准后经内核 confirm 才生效；金额类动作永不低于 L1                       |
| G11 | 数据库迁移只增不改   | 已合并的迁移文件与 journal（`tag`/`when`/`idx`）永不改写；变更一律 `pnpm db:generate` 新增迁移（`migrate:guard` + CI `migrate-upgrade` 强制，见 §5） |

---

## 4. 各端架构约束

### apps/api（后端内核）

- **Kernel（`kernel/`）**：唯一写业务表的模块。任何写操作必须走内核，且**同事务**写 `audit_log`；对外暴露幂等方法（`reviseDraft` / `confirm` / …），禁止在其他模块直接 import 数据库执行写。
- **Tools（`tools/`）**：智能体唯一入口。每个工具 = 一个函数，输入输出用 `packages/schema` 的 Zod 校验；工具内部只调内核方法，不写业务逻辑、不查库旁路。
- **Agents（`agents/`）**：LangGraph.js 编排，状态机 + PostgreSQL 检查点；只调 `tools/`，LLM 调用统一走 LiteLLM 网关（`platform/` 里的 router client），不直连厂商。
- **Approval（`approval/`）**：草稿/修订/审批，落 `revision_requests` / `draft_revisions`；审批卡必须带「出处（Provenance）+ 生效值与来源 + diff」。
- **Print（`print/`）**：模板与数据分离——模板只能引用变量白名单，不能写业务逻辑/查库；打印任务幂等（`idempotency_key`），每次打印留痕（人/时间/模板版本/份数/设备/结果）。
- **Billing（`billing/`）**：计量事件幂等（`idempotency_key`），每日汇总、每月出账；额度 80% 提醒、100% 只停 agent 新任务，**绝不阻断审批/查看/导出**。
- **Gateway（`gateway/`）**：JWT 校验（RS256/JWKS/issuer/audience/exp/nonce）+ membership 映射 + 注入 tenant 上下文；应用角色无 `BYPASSRLS`。
- **Media（`media/` + `platform/storage.ts`）**：`POST /api/media/presign` 签 PUT → 客户端直传对象存储 → `POST /api/media/confirm` HEAD 一次对象才写 `sample_images`。DB 只存 `object_key`，key 由服务端生成 `tenant/<tenantId>/samples/<sampleId>/<uuid>.<ext>`，客户端传 key 一律拒绝。本地 MinIO，生产 COS（S3 兼容）。
- **平台与控制面分离**：`platform_*` / `plans` / `subscriptions` / `usage_*` / `invoices` 属控制面，与租户业务数据分离（独立 schema/库）。

### apps/web（E1 桌面）与 apps/quote（E3 报价页）

- **IA 铁律**：桌面只有「3 个业务窗口 + 1 个管理面」；打印中心是全局抽屉，不新增第四个窗口/一级导航。
- **E3 报价页（`apps/quote` 的 `/s/[token]`）**：独立 Next.js 应用、独立部署；公开路由、无鉴权 Cookie、最小埋点；服务端校验签名 token（哈希命中 + 有效期 + 未撤回）；**只渲染客户视图字段，绝不渲染成本/毛利/内部备注/其他客户**。
- **草稿态视觉统一**：浅底 + 虚线边 + 版本号，批准后变实底；金额用 `tabular-nums` 右对齐。
- **通过 `packages/core` 调 API**：不直接 fetch 绕过；不信任前端，金额/阈值校验在后端。
- **外设能力降级**：`print/scan/readFile/电子秤` 通过 capability 检测，无 Tauri 环境退回浏览器打印/文件上传。

### apps/mobile（E2 移动端，Taro）

- **一套代码三端输出**：用 `process.env.TARO_ENV` 做端差异分支，**禁止为小程序/App 各复制一份**。
- **IA 铁律**：底部 5 入口（今日/审批/相机/客户/更多）；相机优先、语音优先、离线优先；不做批量导入/模板编辑/宽表全景/权限配置（PC 独占）。
- **离线队列**：H5 落 IndexedDB、小程序落 `Taro.setStorage`；恢复后按时间序提交，冲突「服务端版本 + 人工确认」。
- **媒体**：图片压缩（长边 1600px / ≤1MB）后直传对象存储，**禁止 base64 走 JSON**。
- **隐私与安全**：色卡「屏幕色仅供参考」；大额审批 Face ID 二次验证（App 端）；不把 token/成本落本地明文。

### apps/admin（E4 平台总管理端）

- **只连控制面数据**：`platform_*` / `plans` / `subscriptions` / `usage_*` / `invoices`；**默认不读租户业务数据**，需要看业务单据走 break-glass（租户同意 + 双人复核 + ≤60 分钟只读 + 审计）。
- **认证**：独立 Casdoor 应用 `weave-platform`，强制 MFA、禁止社交登录。
- **危险操作双人复核**：删除租户/强制改套餐/清数据；改价/改税需 owner+finance 双人 + 影响试算 + 审计。
- **配置中心**：`platform_configs` 版本化 + 生效日 + 回滚；作用域只有「全局→套餐→租户」三层，不做用户级平台配置。

### apps/print-agent（E5 打印代理）

- **出站长连接**：WSS 出站（Rust `tokio-tungstenite`），**禁止开启入站端口**。
- **最小权限**：token 只能打印、不能读业务数据；本地任务载荷保留 ≤24h，日志脱敏、可一键清空。
- **幂等与留痕**：重复任务用 `idempotency_key` 去重；每次打印回报状态，回执进打印日志。
- **自动更新**：签名包 + 灰度 + 可回滚；崩溃自启、托盘常驻。
- **本地渲染/校准**：支持云端渲染与本地渲染两种模式，本地校准（偏移/浓度/速度）不改云端模板。

### apps/desktop（E1 桌面外设壳，P3）

- **只做外设桥**：Tauri 2 只暴露 `print/scan/readFile/电子秤` 四类 IPC，**业务 UI 一律从 `apps/web` 加载，禁止在壳里写第二套界面**。

---

## 5. packages 约束

| 包                | 约束                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `packages/schema` | 唯一契约来源；只放 Zod 定义，不放业务逻辑；工具/内核/HTTP/env 全部引用它                         |
| `packages/shared` | 只放无副作用的纯函数/常量/类型；禁止依赖 React/NestJS/DB                                         |
| `packages/db`     | Drizzle schema + 迁移 + RLS 策略；所有业务表带 `tenant_id`；只在 `apps/api` 被 import            |
| `packages/core`   | 前端业务逻辑（hooks/API client/离线队列）；不依赖具体端框架，供 web/mobile/admin 复用            |
| `packages/ui`     | 设计系统组件与 tokens；桌面 + admin 复用；移动端用 Taro 组件（对齐 tokens，不直接复用 DOM 组件） |

### packages/db：数据库迁移纪律（G11 的执行细则）

**机制事实**：drizzle 的 `migrate()` 是否重放某条迁移，只看 `drizzle.__drizzle_migrations.created_at`
最大值与 journal 条目 `when` 的大小（`when > max(created_at)` 即重放该条及之后的迁移），`hash` 只写入、
不参与判定。所以**任何对已合并迁移文件或 journal `when` 的改写，都会让存量库重放老迁移**，撞上
`type/table already exists` 卡死——这正是 WAN-98 的根因。

纪律（append-only）：

1. 已合并的 `packages/db/drizzle/*.sql` 不可改写、不可删除；`meta/_journal.json` 中既有条目的
   `tag` / `when` / `idx` 不可变。需要变更就 `pnpm db:generate` **新增**一条迁移。
2. 迁移文件与 journal 条目同一 PR 原子提交（`drizzle-kit generate` 自动成对生成）。
3. 新增迁移优先 `IF NOT EXISTS` 幂等写法；不依赖隐式执行顺序。

强制手段：

- `pnpm --filter @weave-order/db migrate:guard -- <base-ref>`：对比基线，改写/删除已合并迁移直接红。
- CI `migrate-upgrade` job（`.github/workflows/ci.yml`，每次 PR 运行）：守卫 → 按基线迁移出
  「上一个已发布修订」的库 → 恢复 PR 头做增量迁移 → `pnpm db:check` 验收。

存量库已卡死（`already exists` / 记录漂移）：`pnpm db:repair` 只读体检 → 审阅计划 →
`pnpm db:repair -- --apply`（单事务对齐 + 直接执行水位空洞迁移）→ `pnpm db:migrate` → `pnpm db:check`。
完整手册见 `packages/db/README.md`。

---

## 6. 落地建议（分阶段建目录）

| 阶段 | 先建                                                                                                                                                                                      | 后建 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| P0   | `apps/api`（kernel/tools/agents/approval/gateway）、`apps/web`（desktop）、`apps/quote`（`s/[token]`）、`apps/mobile`（Taro H5/PWA）、`packages/schema` / `shared` / `db` / `core` / `ui` | —    |
| P1   | `apps/admin`、`apps/print-agent`、`apps/api` 的 `print` / `billing` / `platform`                                                                                                          | —    |
| P3   | `apps/desktop`、`apps/mobile` 的小程序/RN 输出                                                                                                                                            | —    |

> 现在仓库已有 `apps/api`、`apps/web`、`packages/db`、`packages/schema`、`packages/shared`；按上表增量补齐 `apps/mobile`、`apps/admin`、`apps/print-agent`、`apps/desktop`、`packages/core`、`packages/ui` 即可。

---

## 7. 质量门禁与 CI 内存纪律（WAN-127）

`verify` 作业里的 Lint 步骤是 `pnpm lint` → `scripts/lint.mjs`：**按 workspace 分片，一片一个进程**，规则一行没改（同一份 `eslint.config.mjs`），只是不再让一个 Node 进程扛全仓。

### 为什么必须分片

根配置用 typescript-eslint 的 `projectService` 做类型感知检查，单个 `eslint .` 进程会把它加载过的每个 workspace 的 TS Program 全部留在堆里，峰值随仓库线性增长。2026-11-14 实测（node 22.23.4，12 核 / 15.5 GB RAM）：

| 跑法                            | 墙钟 | 峰值 RSS   | 结果                                      |
| ------------------------------- | ---- | ---------- | ----------------------------------------- |
| `eslint .`（全仓单进程）        | 40s  | **4.20 GB** | 撞 2 GB 堆上限时 exit 134（CI 同款红）     |
| 同上，`main` 前一个绿色提交     | 39s  | 4.03 GB    | 只差 4%，说明一直在贴着墙走                |
| 分片（7 片，最重的是 packages） | 49s  | **1.42 GB** | 通过，留 32% 余量                          |

结论：不是「WAN-120 把内存吃爆了」，而是全仓单进程 lint **一直踩在 2 GB 的临界点上**，WAN-120（+9.5k 行、订单与应收两个大工作面）只是补了最后一脚。所以不要用 `NODE_OPTIONS=--max-old-space-size=...` 把墙往后挪——那只是把 OOM 推迟到下一次提交。

### 分片规则

- 分片表在 `scripts/lint.mjs` 的 `CHUNKS`，按端切（api / web / admin / mobile / quote+site / cli+platform-api+print-agent / packages），日志能直接看出哪个端最吃内存。
- **新增 `apps/*` 或 `packages/*` 目录后必须登记分片**，否则 `pnpm lint` 直接报错退出——漏检比红更贵，宁可挡住提交。
- 单分片峰值超 **1.6 GB** 会打印水位告警，就应该把它再拆小；不要靠调堆上限消警。
- 每次 lint 日志首行打印 `node 版本 · 核数 · 总内存 · V8 堆上限`，峰值逐片打印，以后再遇内存问题不用猜。
- 本地只跑某几片：`node scripts/lint.mjs api web`。

### runner 规格

CI 用 GitHub 托管 `ubuntu-latest`（4 vCPU / 16 GB RAM，Node 22）。崩溃那次日志里 V8 停在 2038.9 MB，即 runner 上实际可用的默认堆上限约 2 GB；以每次 lint 日志首行的实测值为准。
