# 织序 WeaveOrder

纺织贸易的智能体原生业务操作系统。智能体（Agent）是系统的默认操作者，人类只负责审批结果和处理异常。

传统 ERP 软件的架构前提是「业务员是操作者」；织序的前提是「智能体是操作者」。

> 产品设计（定位、角色与权限、传统 ERP 软件能力对照、双端 IA、设计系统、指标与分期）：`docs/product-design.md`。
> 可点击原型（桌面三窗口 + 手机四 Tab）：`prototype/product-design.html`，直接用浏览器打开。
> 用户凭据 / CLI / agent 接入（codex 等）：`docs/cli-and-agent-access.md`，skill 源文件 `skills/weave-order/SKILL.md`。
> 品牌（logo、口号、色彩与字体）：`brand/`，入口 `brand/brand-guide.md`，品牌板 `brand/preview.html`。
> 官方网站与帮助中心（静态站，含价格、下载、登录入口、开通流程、SEO 与 llms.txt）：`apps/site/`（`@weave-order/site`，Astro 5 + Tailwind 4），`pnpm --filter @weave-order/site dev` 后打开 `localhost:4321`；维护方式见 `apps/site/README.md`。

## 技术栈

| 层            | 选型                                                                  |
| ------------- | --------------------------------------------------------------------- |
| 后端          | NestJS + TypeScript                                                   |
| 数据库        | PostgreSQL 16 + pgvector                                              |
| ORM / 查询层  | Drizzle ORM（TypeScript 优先）                                        |
| 缓存与队列    | Redis 7                                                               |
| 向量检索      | 文本：pgvector `vector(1024)` + HNSW；`local-stub` 仍走 `real[]` 兼容 |
| 智能体编排    | LangGraph.js（状态机 + PostgreSQL 检查点，工具调用走 Zod 校验）       |
| 前端·桌面     | Next.js 15（App Router）+ React 19 + Tailwind + shadcn 风格设计系统   |
| 前端·客户报价 | Next.js 15 独立应用 `apps/quote`（`/s/[token]`，SSR、无鉴权 Cookie）  |
| 移动端        | Taro（H5/PWA + 小程序 + RN App）                                      |
| 校验          | Zod（工具输入输出、API 请求响应、环境变量的唯一契约来源）             |
| CLI / agent   | Node 20 + 零运行时依赖（`apps/cli`，bin `weave`）                     |
| 测试          | Vitest（单元 + 内核/HTTP 集成）+ Playwright（端到端，后续）           |

## 目录结构（Monorepo，pnpm workspace + Turborepo）

```
weave-order/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── kernel/      # 确定性内核：唯一可写业务表（含 import.service.ts 批量导入）
│   │   │   ├── tools/       # 工具接口层：智能体唯一可调用的入口
│   │   │   ├── http/        # HTTP 面：目录、工具、审批决策、全景、审计、导入
│   │   │   ├── platform/    # 配置、数据库、Redis、embedding provider
│   │   │   ├── agent/       # 寄样跟进智能体（LangGraph，只调 tools）
│   │   │   ├── approval/    # 审批队列 / 决策 / 全景聚合（第五步）
│   │   │   ├── import/      # Excel/CSV 文件解析适配器（只解析、不写库，第六步）
│   │   │   ├── gateway/     # Casdoor OIDC 验签 + membership → tenant 上下文
│   │   │   └── auth/        # 个人访问凭据（PAT）+ CLI 设备登录
│   │   ├── scripts/         # demo / demo-followup / import-data 冷启动
│   │   └── test/            # 边界 / 单元 / 内核集成 / HTTP e2e / 导入集成
│   ├── cli/                 # `weave` 命令：设备登录、凭据管理、业务工具、skill 安装
│   ├── web/                 # Next.js 15：三个业务窗口 + 组织设置 + /auth/callback（E1）
│   └── quote/               # Next.js 15 客户报价页（/s/[token]，SSR、无鉴权 Cookie，E3）
├── packages/
│   ├── schema/              # Zod 契约（前后端 / 工具 / 内核唯一来源，含 import.ts）
│   ├── core/                # 前端业务逻辑：API client / TanStack Query hooks / 离线队列
│   ├── ui/                  # 设计系统：tokens + 16 组件（草稿态统一视觉）
│   └── db/                  # Drizzle Schema、连接、SQL 迁移
├── skills/weave-order/      # agent skill（SKILL.md）：codex 等加载后即可操作织序
├── data/seed/               # 冷启动样例数据（customers.csv / samples.csv / .xlsx）
├── docker-compose.yml       # PostgreSQL + pgvector、Redis
├── turbo.json
└── pnpm-workspace.yaml
```

## 本地运行

```bash
# 1. 依赖
corepack enable
pnpm install

# 2. 一条命令起全部 URL 端
#    自动：docker compose 的 postgres/redis → 迁移 → 构建共享包 → 并行起各端 → 打印地址清单
pnpm dev

# 3. 样例数据（可选；pnpm dev 已含迁移）
pnpm seed          # 导入 data/seed/*.csv 的客户/样品；详见「数据导入与冷启动」
pnpm demo          # 可选：内核演示 + 寄样跟进智能体（另造演示数据）

# 3b. 可选：图片链路需要 S3 兼容对象存储。Docker Hub 不可达时用官方二进制脚本
#     （端口/凭据/bucket 与 compose 的 minio 一致，API 无需额外配置）
scripts/dev-storage-up.sh
```

`pnpm dev` 最后统一打印一张清单（全部返回 200 才算就绪）：

| 端               | 地址                              | health / 首页          |
| ---------------- | --------------------------------- | ---------------------- |
| API 内核         | http://localhost:3000             | `/api/health`          |
| 工作台 web       | http://localhost:3001             | `/login`               |
| 客户报价 quote   | `http://localhost:5174/s/<token>` | `/s/dev-readiness`     |
| 平台控制台 admin | http://localhost:3003             | `/login`               |
| 官网 site        | http://localhost:4321             | `/`                    |
| 平台控制面 API   | http://localhost:3002             | `/platform/api/health` |
| 移动端 H5        | http://localhost:10086            | `/`                    |

常用开关：`pnpm dev web api`（只起指定端）、`--no-mobile`（跳过 Taro watch）、
`--no-infra` / `--no-migrate` / `--no-build`（跳过对应预备步骤）、`--list`（只看清单）。
`cli`（交互式终端）与 `print-agent`（Tauri，需 Rust 工具链）不是 URL 服务，各有独立入口：
`pnpm dev:cli` / `pnpm dev:desktop`。端口被占用时脚本会直接报出冲突端并退出，不会假就绪。

桌面端是**三个业务窗口 + 一个管理面**：工作台（⌘1）、审批（⌘2）、全景只读（⌘3）、
组织设置（⌘,）。打印是全局抽屉，不是第四个窗口。智能体只出 `DRAFT` / 建议；
批准 / 拒绝是审批窗口里人类唯一的决策入口，前端经 `/api/approvals/decide` 调内核 confirm 生效（铁律 #2）。

首次本地预览可以不带后端：开发模式下访问 `http://localhost:3001/today?demo=1` 使用 mock transport
（生产构建禁用 demo 入口）。真实联调时用 `GET /auth/dev` 写入 dev token（默认 `dev:demo:demo`），
或配置 Casdoor 走 `/auth/login` → `/auth/callback`（Authorization Code + PKCE，客户端不持有 secret）。

OIDC token 只存 **httpOnly Cookie**；浏览器只调同源 `/api/*`，由 Next BFF
（`apps/web/app/api/[...path]/route.ts`）在服务端注入 `Authorization` 转发给 Nest。
前端脚本不读 token、不落 localStorage，生产也不需要开放跨域。

需要从终端或 agent（codex 等）操作时，用个人访问凭据（PAT）而不是 OIDC 会话：

```bash
pnpm --filter @weave-order/cli build
node apps/cli/bin/weave.js login          # 设备码：浏览器需已登录织序，确认后凭据落 0600 文件
node apps/cli/bin/weave.js whoami         # 租户 + 角色 + 作用域
node apps/cli/bin/weave.js skill install  # 装到 ~/.codex/skills/weave-order/
```

PAT 绑定 membership，仍然走同一租户与 RLS；默认作用域 `read,write`，审批需要
人类显式签发 `approve`。详见 `docs/cli-and-agent-access.md`。

> E3 客户报价页是独立 Next.js 应用：SSR + 无鉴权 Cookie + 独立部署，
> 客户面与租户面彻底隔离，也不与 `apps/web` 的登录 Cookie 串扰。详见 `apps/quote/README.md`。

`demo` 逐项展示：

1. 内核建客户（业务表 + 同事务审计写入）
2. 内核建样品（带成本底线）
3. 智能体通过工具 T-005 创建寄样单 —— 只能得到 `DRAFT`
4. 智能体调用确认 → 内核拒绝 `PERMISSION_DENIED`；人类确认 → `CONFIRMED`
5. 智能体通过工具 T-004 生成报价草稿 —— 金额由内核整数计算
6. 低于成本底线的报价 → 内核拒绝 `PRICE_BELOW_COST_FLOOR`
7. 找样工具 T-002（参数匹配）/ T-001（以图搜图，默认 local stub 图像向量）
8. 审计日志逐条列出，数据库触发器拒绝改写

本地手填配置直接维护在根目录 `.env`（进 git），默认值与 `docker-compose.yml` 一致。
演示**不依赖任何外部模型 key**：embedding 默认走 `local-stub`（哈希、无语义）。
真实语义检索用 `EMBEDDING_PROVIDER=dashscope-text-v3` + key，细节见
[`docs/semantic-search.md`](docs/semantic-search.md)。
真实图搜图用 `IMAGE_EMBEDDING_PROVIDER=dashscope-qwen3-vl` + key，历史图片用
`pnpm --filter @weave-order/api reindex:images --ensure-index` 回填，细节见
[`docs/image-search.md`](docs/image-search.md)。
图墙缩略图由服务端派生并落盘（`_320.webp` / `_640.webp`），存量用
`pnpm --filter @weave-order/api maintain:media` 补派生 / 压原图 / 清孤儿，细节见
[`docs/media-thumbnails.md`](docs/media-thumbnails.md)。

### 常用命令

```bash
pnpm build        # 构建
pnpm dev          # 全部 URL 端（api/web/quote/admin/site/platform-api/mobile）
pnpm dev:cli      # 只起交互式 CLI（非 URL 服务）
pnpm dev:desktop  # 只起打印代理 Tauri（需 Rust 工具链）
pnpm test:scripts # dev 统一入口的单元用例（端口/表格渲染）
pnpm lint         # 先构建契约包，再按 workspace 分片跑类型感知 ESLint（含目录边界规则）
pnpm typecheck    # 全仓类型检查
pnpm test         # 单元 + 边界；有本地 PG 时内核/HTTP 集成测试自动启用
pnpm db:generate  # 改完 Drizzle Schema 后生成 SQL 迁移
pnpm db:migrate   # 应用迁移
pnpm demo         # 迁移 + 内核演示 + 寄样跟进智能体（含检查点续跑）
pnpm demo:followup # 只跑寄样跟进智能体演示
pnpm --filter @weave-order/cli build   # 构建 weave CLI（bin: apps/cli/bin/weave.js）
pnpm demo:quote    # 客户原话 → 候选样品 → 定价依据 → 报价 DRAFT（+ token 计量）
pnpm demo:reset    # 清库 + 重迁移 + seed + 剧本锚点 + 刷会话（生产拒绝执行）
pnpm seed         # 迁移 + 导入样例客户/样品（Excel/CSV，冷启动）
pnpm format       # Prettier
```

### 内核与审批（Track A）

报价全链路已在内核落地：建客户 → 建样品 → 报价草稿（DRAFT）→ 改价
（版本 +1、重算、逐行 diff）→ 改幅/金额超阈值自动升级审批 → 人类批准 → confirm。

- 定价继承：系统 → 公司 → 团队/客户/品类 → 个人；管控类（`locked`）只能收紧，
  解析结果同时返回「生效值 + 来源」。
- 审批阈值：默认 5 万 / 20 万 / 无上限；改幅超过 5% 或 1 万元自动升级主管。
- 审批角色从登录态 membership 注入（生产缺令牌 401、缺角色 fail-closed），
  不再硬编码 OWNER。
- 改稿 / 驳回同事务写 `audit_log`、`revision_requests`、`draft_revisions`、
  `decision_deltas`，AI 只能产出 Patch，改账本必须 HUMAN。

接口与验收细节见 `docs/track-a-kernel.md`；常驻用例：
`apps/api/test/track-a.integration.test.ts`、`apps/api/test/track-a.e2e.test.ts`。

### 智能体编排（第四步）

寄样跟进智能体的完整旅程，由 LangGraph 状态机编排、检查点存 PostgreSQL：

```
建寄样单(T-005) → 追踪物流 → 生成跟进建议 → 等待客户回复(interrupt)
   → 识别回复 → 客户询价? → 生成报价草稿(T-004, DRAFT) → DONE
                          ↘ 不问价 → DONE
```

- 节点只调用 tools；agent 层不 import kernel（ESLint 边界）。
- 所有产出停在 `DRAFT` / 建议态：寄样单、跟进建议、报价草稿都需要人类后续确认。
- 物流、LLM、客户回复来源都是 provider 接口，默认本地确定性实现，零外部 key：

| 能力                | 默认实现                            | 环境变量             | 接真实服务时                                          |
| ------------------- | ----------------------------------- | -------------------- | ----------------------------------------------------- |
| 跟进建议 / 回复意图 | `local-rule`（规则引擎）            | `LLM_PROVIDER`       | 实现 `LlmProvider`                                    |
| 物流轨迹            | `local-deterministic`（运单号哈希） | `LOGISTICS_PROVIDER` | 实现 `LogisticsProvider`                              |
| 客户回复来源        | `local-scripted`（脚本化）          | `REPLY_SOURCE`       | 实现 `ReplySource`（微信/邮件适配器负责原始报文解析） |

检查点：LangGraph 官方 `PostgresSaver`，表（`checkpoints` / `checkpoint_blobs` /
`checkpoint_writes`）由 `setup()` 幂等创建，与业务表的 Drizzle 迁移互不干扰。

`pnpm demo` 会真实演示续跑：进程 A 跑到「等待客户回复」中断并打印 checkpoint id，
随后启动**全新 Node 进程 + 新连接池**的进程 B，从同一 thread 恢复、注入客户回复、
识别询价并产出 `DRAFT` 报价，最后打印两边的审计流水。

### 最小 HTTP 面

| 方法   | 路径                                  | 身份 / 状态                   | 说明                                             |
| ------ | ------------------------------------- | ----------------------------- | ------------------------------------------------ |
| GET    | `/api/health`                         | 只读                          | 服务 + 数据库可用性                              |
| GET    | `/api/customers`                      | 只读                          | 客户列表 + 聚合（未决报价 / 在途寄样 / 应收）    |
| GET    | `/api/customers/:id`                  | 只读                          | 客户 360：档案 + 上下文 + 汇总                   |
| GET    | `/api/customers/:id/timeline`         | 只读                          | 客户时间线（游标分页，可按单据类型筛选）         |
| GET    | `/api/samples`                        | 只读                          | 样品图墙（`query`/`category`/`status`/游标分页） |
| POST   | `/api/samples`                        | HUMAN（样品管理员/经理/老板） | 新建样品（可带已上传的 `imageKeys`）             |
| GET    | `/api/samples/:id`                    | 只读                          | 样品详情（图片按 `sortOrder`，成本按角色裁剪）   |
| PATCH  | `/api/samples/:id`                    | HUMAN（样品管理员/经理/老板） | 编辑规格 / 图片顺序 / 主图                       |
| POST   | `/api/samples/:id/archive`            | HUMAN（样品管理员/经理/老板） | 归档（软删，`status=ARCHIVED`）                  |
| GET    | `/api/audit`                          | OIDC / `read` PAT             | 审计流水（只看本租户）                           |
| POST   | `/api/tools/search-by-spec`           | agent                         | T-002 参数匹配                                   |
| POST   | `/api/tools/search-by-image`          | agent                         | T-001 以图搜图（base64 / imageUrl）              |
| POST   | `/api/tools/generate-quote-draft`     | agent → `DRAFT`               | T-004 生成报价草稿                               |
| POST   | `/api/agents/quote`                   | agent                         | 粘贴客户原话 → 候选 + 定价依据 + DRAFT + 缺失项  |
| POST   | `/api/tools/create-sample-shipment`   | agent → `DRAFT`               | T-005 创建寄样单草稿                             |
| POST   | `/api/approvals/decide`               | HUMAN（审批窗口唯一决策入口） | 批准 / 拒绝 → 内核 confirm / reject              |
| GET    | `/api/approvals`                      | 只读                          | 审批队列（仅 pending 的 DRAFT 单据）             |
| GET    | `/api/approvals/:id?kind=quote`       | 只读                          | 审批卡详情：出处 / diff / 草稿态                 |
| GET    | `/api/panorama`                       | 只读                          | 业务全景聚合快照（单据 / 统计 / 审计）           |
| POST   | `/api/import`                         | HUMAN                         | Excel/CSV 冷启动：整批原子导入客户/样品          |
| POST   | `/api/auth/device/start`              | 无                            | CLI 设备登录：申请一次性确认码                   |
| POST   | `/api/auth/device/poll`               | 无                            | CLI 轮询；批准后一次性换 token                   |
| POST   | `/api/auth/device/decide`             | OIDC / `approve` PAT          | 人类确认 CLI 登录（`/cli-login` 页面调用）       |
| GET    | `/api/auth/whoami`                    | OIDC / PAT                    | 凭据 + 成员身份 + 租户                           |
| GET    | `/api/auth/tokens`                    | OIDC / PAT                    | 列出自己的个人凭据                               |
| POST   | `/api/auth/tokens`                    | OIDC / `write` PAT            | 签发个人凭据（明文只返回一次）                   |
| DELETE | `/api/auth/tokens/:id`                | OIDC / PAT                    | 撤销个人凭据（立即失效）                         |
| POST   | `/api/quotes/:id/shares`              | HUMAN（仅 SENT 报价）         | 生成客户报价链接（明文 token 只返回一次）        |
| GET    | `/api/quotes/:id/shares`              | 只读                          | 分享列表 + 访问/接受/提问聚合数据                |
| POST   | `/api/shares/:id/revoke`              | HUMAN                         | 撤回链接，立即 410                               |
| GET    | `/api/public/quotes/:token`           | 公开（无登录）                | 客户视图；`?track=0` 用于打印不重复计数          |
| POST   | `/api/public/quotes/:token/accept`    | 公开（可选手机尾号）          | 记录成交意向（不改账本）                         |
| POST   | `/api/public/quotes/:token/questions` | 公开                          | 客户留言提问                                     |
| POST   | `/api/public/quotes/:token/pdf`       | 公开                          | 记录 PDF 下载事件                                |
| POST   | `/api/quote-shares`                   | HUMAN（仅 SENT 报价）         | 移动端契约：quoteId 在 body，返回裸对象          |
| GET    | `/api/quote-shares?quoteId=`          | 只读                          | 移动端契约：链接访问时间线                       |

> 带 `Authorization` 时，工具面（`/api/tools/*`、`/api/agents/quote`）与 `/api/audit` 都在
> 为该成员打开的租户会话内核里执行（铁律 G4）：读写与审计落库的 `tenant_id` 由这条会话决定，
> 不是构造期固化的演示租户；不带凭据只是本地/演示行为，生产态 401。
> 工具与审批的业务失败仍是 `{ ok: false, error }` 这个 body，但状态码按 `code` / `reason`
> 映射为 400 / 403 / 404 / 409 / 422 / 502，映射表见 `docs/cli-and-agent-access.md` §4.1。
>
> 三个窗口的前端**只**调用上表的只读目录、工具（agent 身份）、`/api/approvals/decide`
> 三类接口；不提供任何「前端直连内核 / 写业务表」的端点。批准 / 拒绝由
> `apps/api/src/approval` 调内核 `confirmDraft` / `confirm`（批准）或
> `rejectDraft` / `reject`（驳回），内核再校验 `actor.type === "HUMAN"` 兜底。
> 第三步遗留的旧路由 `POST /api/quotes/:quoteId/confirm` 已在第六步删除，
> 审批决策只有 `decide` 一个入口。
>
> **「唯一入口」的口径**：指**审批决策**——`POST /api/approvals/decide` 是 HUMAN 上下文里
> 唯一能推动 `DRAFT` 单据状态流转（批准 / 驳回）的入口，这一点字面成立。
> `POST /api/import` 不属于审批决策：它是人类运维动作、独立的数据冷启动域（与 CLI `pnpm seed`
> 共用同一个内核 `ImportService`），也不改变任何单据状态。不要把「唯一」读成跨域独占。

### 三个窗口与审批 API（第五步）

| 窗口                         | 职责                                                                 | 写操作                                   |
| ---------------------------- | -------------------------------------------------------------------- | ---------------------------------------- |
| ① Intent Bar（任务派发）     | 选上下文（客户 / 样品）、派发意图；智能体通过工具产出 `DRAFT` / 建议 | 仅工具调用（agent 身份），产出停在 DRAFT |
| ② Review Queue（审批分诊）   | 列出 pending `DRAFT` 草稿；人类批准 / 拒绝；驳回可带分诊备注         | `/api/approvals/decide`（HUMAN）         |
| ③ Read-Only Panorama（全景） | 账本状态、客户、样品、审计统计；异常 / 驳回分诊台账；纯只读          | 无                                       |

端到端（`pnpm demo` 后 `pnpm dev` 可当场演示）：

```
Intent Bar 派发意图 → 工具产出 DRAFT 报价/寄样单 → GET /api/approvals 出现在队列
  → 审批窗口点「批准 / 拒绝」→ POST /api/approvals/decide（HUMAN 上下文）
  → kernel confirm / reject 同事务改状态 + 写审计
  → 报价 DRAFT→SENT / 寄样单 DRAFT→CONFIRMED（批准），或 →REJECTED / →CANCELLED（驳回）
  → GET /api/panorama 与审计流水立刻可见
```

技术栈：Next.js 15 App Router + React 19 + Tailwind + `packages/ui` 设计系统。

- 数据与状态走 `packages/core`（TanStack Query hooks + API client），页面不裸 fetch；
  契约（输入 / 结果 / 只读视图）全部来自 `packages/schema`，前端不重复定义任何业务结构。
- 审批卡详情来自 `GET /api/approvals/:id?kind=`：出处、diff、草稿态由后端只读聚合。
- 设计系统 16 组件在 `packages/ui`：`DraftCard` / `ApprovalSheet` / `DiffRow` / `ProvenanceChip` /
  `MoneyText` / `RiskBadge` / `MissingFieldBadge` 等；草稿态统一「浅底 + 虚线边 + 版本号」。

包公记录项处理：

- **记录项①（已修）**：派发任务缺运单号曾让整条旅程在 `TrackingSnapshot` 处以 Zod
  `too_small` 原文失败。现在图入口（`createShipment` 节点）即以明确业务错误码
  `NO_TRACKING_NUMBER` 拒绝，不产生任何副作用；`packages/schema/src/agent.ts` 导出该常量，
  `apps/api/test/agent-graph.test.ts` 有回归用例。
- **记录项②（记录在案，无需改）**：本地规则意图识别「首个命中即返回」是演示口径，
  接真实 LLM provider 后自然消失。

### 数据导入与冷启动（第六步）

干净 clone 起服务后，导入一份样例客户 / 样品数据即可直接跑通 demo 与审批流：

```bash
docker compose up -d
pnpm seed          # = 迁移 + 导入 data/seed/customers.csv + samples.csv
SEED_RESET=1 pnpm seed   # 数据已存在：同事务重置 seed 行后重导（见下）
# 或换成 Excel 工作簿（含 customers / samples 两个 sheet）：
IMPORT_XLSX=data/seed/weave-order-seed.xlsx pnpm seed
pnpm demo          # 可选：内核演示 + 寄样跟进智能体（另造演示数据）
pnpm dev           # http://localhost:3001
```

- 来源：`data/seed/customers.csv` + `samples.csv`（CSV），或 `weave-order-seed.xlsx`
  （Excel，两个 sheet）。环境变量 `IMPORT_CUSTOMERS` / `IMPORT_SAMPLES` / `IMPORT_XLSX`
  可覆盖（见 `.env`）；解析在 `apps/api/src/import/parse.ts`（CSV: `csv-parse`，
  XLSX: `exceljs`），CLI 在 `apps/api/scripts/import-data.ts`。
- **归属**：seed 客户挂到演示业务员成员（默认 `demo-sales`，dataScope=`OWN`），
  所以 `Bearer dev:demo-sales:demo` 能看到；`Bearer dev:demo:demo`（OWNER，ALL）看全量。
  subject / 租户可用 `SEED_*` 环境变量覆盖，详见 `docs/data-ownership.md`。
- **历史无归属数据**：`owner_id IS NULL` 的客户对 `OWN` 一律不可见；
  `pnpm db:backfill-owner`（只读）检查，`pnpm db:backfill-owner -- --apply`
  单事务归给各租户最早的 ACTIVE OWNER 成员，详见 `docs/data-ownership.md`。
- HTTP 入口：`POST /api/import` 收结构化 `ImportBatch`（HUMAN 上下文），与 CLI 共用同一
  内核 `ImportService`。前端三个窗口不提供导入表单（逐条录入是明令禁止的），导入是
  **人类运维动作**：CLI 或 HTTP 都可发起，但一律落到内核。

**口径：整批原子、全量校验、单事务回滚（all-or-nothing）** —— 不做「逐行提交、
坏的跳过」，因为那会半途留脏数据。四步：

1. 信封 + **每行**用 `packages/schema` 的 `CustomerImportRow` / `SampleImportRow`
   （复用内核 `CreateCustomerInput` / `CreateSampleInput`，`.strict()`）校验，纯阶段零写入；
2. 批内 `code` 重复（`DUPLICATE_IN_BATCH`）、库中已有 `code`（`DUPLICATE_IN_DB`，只读预检）
   都给逐行可判别回执；
3. 任一行被拒 → 整批不提交（`BATCH_REJECTED`），**一行不落**；合法行也各有 `ok` 回执，
   便于修正后重导；
4. 全部通过 → 一个 `db.transaction` 写入客户（+ 私有上下文）、样品（+ 向量）与
   **同事务 HUMAN 审计**（共用 `correlationId`）；任何写入抛错（含唯一约束并发兜底）
   整个事务回滚 → `WRITE_FAILED`，仍是一行不落。

`ImportBatchResult` 的失败语义全部是封闭可判别联合：批次级
`PERMISSION_DENIED` / `INVALID_BATCH` / `BATCH_REJECTED` / `WRITE_FAILED`，行级
`INVALID_INPUT`（带逐字段 issues）/ `DUPLICATE_IN_BATCH` / `DUPLICATE_IN_DB` /
`WRITE_FAILED`。`committed=true` 才代表全批落库；否则导入计数恒为 0。

架构铁律照旧：导入写业务表**只经内核 service**（`kernel/import.service.ts` 是唯一
批量写入者，单条 `create` 与批量导入共用 `insertWithin` 一处写逻辑）；`http` / 工具层 /
`import` 适配层都禁止直连数据库（ESLint `no-restricted-imports` + `boundary.test.ts`）。
`http` 层唯一例外是组合根的两个文件：`http.module.ts`（把 `DatabaseProvider` 装配进 Nest DI）
与 `database.provider.ts`（真正建连接），它们只允许 import `../platform/database`，
`pg` / `drizzle-orm` / `@weave-order/db` 在例外内也照样被拦——例外范围就这两条，不向外扩。
导入链路同样不出现 `any`（行内容用 `unknown` 承载，由契约逐行校验）。默认重复运行同一 seed
会因 `DUPLICATE_IN_DB` 整批拒绝（不会重复落库）；需要重导同一份 seed 时显式开启重置：

```bash
SEED_RESET=1 pnpm seed
```

重置仍在同一个事务内完成：先按本批 code 删除旧客户 / 样品（连同 `customer_contexts`、
`sample_embeddings`，以及引用它们的报价、寄样单与明细），再整批写入，每删一个旧实体写
`IMPORT_RESET` 审计。任何一步失败整批回滚，旧数据不会丢一半；引用记录之外的业务数据不受影响。

**CustomerContext 确认**：P0 已有着落 —— `customer_contexts` 表、创建客户时内核自动
写默认上下文、`getContext` / `getHistory` / `appendDecisionDelta` 读写。导入客户时同样
按契约初始化；可选 `context` 字段（`preferenceNotes` / `pricingBehavior` /
`paymentPattern` / `followupPreference`，复用领域契约）会一并校验并落库，
`decisionDeltas` / `customerId` / `updatedAt` 仍由内核管理、不接受导入。
集成测试断言导入后 `getContext` 读得回带去的私有字段。

## 架构铁律（不可违反）

1. **确定性内核与智能体外壳分离**：智能体永远不直接修改库存数量、应收金额、合同状态等业务账本；所有涉及账本和资金的动作必须通过确定性内核的工具接口执行，并写入审计日志。
2. **智能体输出一律是「草稿 / 建议」**：人类在审批窗口确认后，前端调用内核 confirm 接口才正式生效。
3. **每个业务能力以工具（Tool）形式暴露**：工具输入输出有严格 Schema 校验；智能体不「打开页面」，只调用工具。
4. **人类界面只有三个窗口**：任务派发（Intent Bar）、审批与异常分诊（Review Queue）、业务全景只读视图（Read-Only Panorama）。

### 铁律在代码与数据库里的落点

| 铁律           | 落地方式                                                                                                                                                                | 可验证点                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 智能体不改账本 | 只有 `apps/api/src/kernel` 能写入业务表；工具层只拿到 `Kernel` 对象，拿不到 `Db`                                                                                        | `eslint.config.mjs` + `apps/api/test/boundary.test.ts` |
| 越权路径封死   | agent 禁止 import kernel / drizzle-orm / pg / `@weave-order/db`；tools / approval / import / http 禁止直连数据库（http 仅组合根两文件可 import `../platform/database`） | 同上，含裸 barrel `../kernel`                          |
| 输出必须是草稿 | 内核 `createDraft` 强制 `DRAFT`；`confirm*` / `reject*` 校验 `actor.type === "HUMAN"`                                                                                   | demo、内核/HTTP 集成测试                               |
| 金额不可伪造   | 金额一律整数「分」，PG `bigint` 存储；行金额用 BigInt 计算再一次 half-up；契约层 `Money.max(MAX_SAFE_INTEGER)`                                                          | `packages/schema`、`apps/api/src/kernel/money.ts`      |
| 改账必须留痕   | 业务写入与审计写入同一事务；`audit_log` 由数据库触发器禁止 UPDATE / DELETE                                                                                              | demo、内核集成测试                                     |
| 导入整批原子   | 全量逐行 Zod 校验 → 任一坏行/重复整批不提交 → 单事务写入 + HUMAN 审计；失败整批回滚、零脏数据                                                                           | `apps/api/test/import.integration.test.ts`             |
| 契约唯一来源   | 所有 Zod Schema 只在 `packages/schema`；数据库枚举与契约枚举由测试比对                                                                                                  | `apps/api/test/schema-parity.test.ts`                  |
| 检索可替换     | embedding 是 provider 接口，默认 local stub，不需要模型 key                                                                                                             | `apps/api/src/platform/embedding.ts`                   |

## 目录边界铁律

- `apps/api/src/kernel/` 下的 service 是唯一可以写业务表的代码。
- `apps/api/src/tools/` 只调用 kernel 的 service，不直接连数据库。
- `apps/api/src/import/` 只做 Excel/CSV 解析（列 → 字段映射），不写业务表、不连数据库。
- `apps/api/src/agent/` 只调用 tools/ 的接口，不 import kernel/ 的任何模块，也不触达数据库。**已用 ESLint `no-restricted-imports` 强制**（`eslint.config.mjs`），tools / approval / import 适配层与 `http` 层（控制器、context、tokens）同样禁止直连数据库，并有常驻回归测试（`apps/api/test/boundary.test.ts`）锁定。
- `apps/api/src/http/` 的**唯一例外**是组合根：`http.module.ts`（Nest 模块装配 `DatabaseProvider`）与 `database.provider.ts`（建连接）。这两个文件只放开 `../platform/database`，`pg` / `drizzle-orm` / `@weave-order/db` 仍被拦；`boundary.test.ts` 对控制器/context 与组合根分别断言，改配置会被测出来。
- `packages/schema/` 的 Zod Schema 是前后端、工具层、内核、导入的唯一契约来源，不重复定义。

## 契约设计（packages/schema）

- `src/common.ts` — 统一失败语义：以 `code` 区分的可判别联合，调用方可 `switch (error.code)` 精确分流。
- `src/domain.ts` — 领域实体：Customer、CustomerContext、FabricSample、SampleShipment、Money、Quantity、JsonValue 等。
- `src/kernel.ts` — 内核输入契约与审计日志读取模型；全部 `.strict()`（未知字段一律拒绝）。
- `src/approval.ts` — 审批队列、决策入参 / 回执、业务全景只读快照的契约（第五步）。
- `src/import.ts` — 导入批次 / 逐行契约（复用内核 Create 输入）、可判别失败码与回执、`CustomerContextImport`（第六步）。
- `src/agent.ts` — 智能体状态 / 建议 / 信号契约，含 `NO_TRACKING_NUMBER` 业务错误码。
- `src/tools/t001-search-fabric-by-image.ts` — 以图搜图输入 / 输出 / 相似度范围。
- `src/tools/t002-search-fabric-by-spec.ts` — 参数匹配输入 / 输出 / `matchedOn`（关键词中的 `%` / `_` 按字面量匹配）。
- `src/tools/t003-get-customer-history.ts` — 客户历史。
- `src/tools/t004-generate-quote-draft.ts` — 报价草稿，`amountsComputedByKernel: true`。
- `src/tools/t005-create-sample-shipment.ts` — 寄样单草稿 + 内核建议跟进时间。
- `src/tools/t006-suggest-line-price.ts` — 确定性建议单价 + 可点开的定价依据（成本底线 / 等级加价 / 取整）。
- `src/quoting.ts` — 找样 / 报价 agent 的槽位、候选、缺失项、最终结果契约。
- `src/llm.ts` — LLM 设置（全局 + 租户覆盖）、token 用量、月度汇总、预算状态。

关键约束：

- **金额以整数「分」表示**，DB 列为 `bigint`（Drizzle `mode: "number"`），单笔上限从 int4 的约 2147 万元提升到 90 万亿元；契约层再以 `Number.MAX_SAFE_INTEGER` 兜底。
- **数量以「千分之一单位」整数存储**，乘法用 BigInt 完成，超界显式 `KERNEL_REJECTED`。
- **输入 `.strict()`**：智能体不能夹带 `status`、`version` 等账本字段。
- **不留 `any`**：异构值用带类型的递归 `JsonValue`。

## 数据模型

| 表                                           | 说明                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `customers`                                  | 客户主表，`version` 支持乐观并发                                             |
| `customer_contexts`                          | 客户私有上下文（护城河）：选样偏好、报价行为、付款行为、跟进偏好、决策增量   |
| `samples`                                    | 面料样品，含报价成本底线（bigint 分）                                        |
| `sample_shipments` / `sample_shipment_items` | 寄样单与明细，DRAFT → CONFIRMED                                              |
| `quotes` / `quote_items`                     | 报价单与明细，金额 bigint，行金额/总额由内核计算                             |
| `sample_embeddings`                          | 样品向量索引（model + dimension + `real[]`），创建样品时写入                 |
| `audit_log`                                  | 追加型审计日志，数据库触发器禁止 UPDATE / DELETE / TRUNCATE                  |
| LangGraph 检查点表                           | `checkpoints` / `checkpoint_blobs` / `checkpoint_writes`（saver setup 创建） |

迁移在 `packages/db/drizzle/`，由 `drizzle-kit generate` 生成、`pnpm db:migrate` 应用。
迁移纪律（已合并迁移/journal 只增不改）、存量库修复（`pnpm db:repair`）与 CI 升级演练见
`packages/db/README.md` 与 `docs/development-guide.md` §5「数据库迁移纪律」。
检查点表由 LangGraph `PostgresSaver.setup()` 幂等创建（与业务迁移分离）。

## 本轮范围

六步全部完成（P0 收尾）。第六步（Excel/CSV 导入 + 冷启动）已完成，累计包含前五步能力：

- 确定性内核、工具接口层、LangGraph 编排、审计日志、目录边界 ESLint 规则（第一~四步）。
- `apps/web` 桌面三窗口 + 组织设置（Next.js 15 + React 19 + `packages/ui` 设计系统）；审批卡带出处 / diff / 草稿态。
- `apps/api/src/approval`：审批队列、批准 / 拒绝决策、业务全景聚合；只调用 kernel。
- 批准 / 拒绝端到端：approval API → confirm / reject → 账本状态生效 → 全景 / 审计可见。
- 包公记录项①：缺运单号改走明确业务错误码 `NO_TRACKING_NUMBER`（图入口校验）；记录项②仅在案未改。
- 第六步：Excel/CSV 导入（`csv-parse` + `exceljs`）、`data/seed` 样例数据、`pnpm seed` 冷启动、
  内核 `ImportService` 整批原子 / 单事务回滚、逐行可判别回执、HUMAN 审计、CustomerContext 按契约处理。
- 收掉遗留旧路由 `POST /api/quotes/:quoteId/confirm`：`decide` 成为 HUMAN 上下文里唯一的**审批决策**入口（HTTP e2e 断言旧路由 404）；`POST /api/import` 是独立的人类运维域，不计入这条不变量。

未做（P1 及以后，本步严格未外溢）：跟单异常 / 对账智能体、H5 / 小程序、ERP 集成、
pgvector 索引与真实 embedding / LLM / 物流 / 渠道 provider。

## T0 地基（契约冻结 + 多租户 + 网关）

在既有六步 MVP 之上完成并行开发前置：

- **契约**：`packages/schema` 新增租户/成员、订单/发货/应收、改稿、报价分享与统一 HTTP 错误契约；
  所有实体输出带 `tenantId`，输入 `strict()`（前端不得传 `tenantId`）。
- **数据层**：全部业务表加 `tenant_id`，`ENABLE + FORCE ROW LEVEL SECURITY`，
  应用角色 `weave_app`（`NOSUPERUSER` / `NOBYPASSRLS`）由迁移创建；策略与角色在
  `packages/db/sql/rls.sql`，`pnpm db:migrate` 幂等应用。
- **网关**：`apps/api/src/gateway` 做 Casdoor OIDC（RS256/JWKS/issuer/audience）校验，
  `(sub, org)` → 本地 `memberships` → 租户会话（`SET app.tenant_id`）。
  `GET /api/auth/me`、`GET /api/auth/customers`；本地 `AUTH_MODE=dev` 支持
  `Authorization: Bearer dev:<sub>:<org>`，生产强制 `oidc`。
- **前端骨架**：`apps/mobile`（Taro 五 Tab：今日/审批/相机/客户/更多）、
  `packages/core`（API client / TanStack Query hooks / 离线队列）、
  `packages/ui`（设计 tokens + 基础组件）。
- **移动端 P0（Track D）**：Taro 一套代码输出 H5/PWA；手机「粘贴原话 → 改价 → 批准 → 分享链接」主链路、
  离线队列（IndexedDB / Taro Storage，冲突人工确认）、图片压缩后直传对象存储、语音批注与 PWA 安装。
  演示：`pnpm --filter @weave-order/mobile dev`（本地 mock，无需后端）；真后端见 `apps/mobile/README.md`。
- **验收**：`apps/api/test/tenancy.integration.test.ts` 覆盖「建租户→建成员→建客户→建样品→出报价草稿
  - 审计同事务」与跨租户 RLS 拦截；CI `.github/workflows/ci.yml` 常驻执行。
- **本地基础设施**：`docker compose up -d` 增加 LiteLLM（`:4000`），配置在 `infra/litellm/config.yaml`。

契约与各 Track 开工约定详见 `docs/t0-foundation.md`。

## Track B · 找样 / 报价智能体 + LiteLLM（WAN-84）

在 T0 契约之上新增：

- **agent**：`apps/api/src/agent/quoting-graph.ts`，客户原话 → 槽位 → 候选样品（确定性命中理由）
  → 内核定价 → `DRAFT`；缺客户 / 数量 / 样品 / 定价依据时返回 `NEEDS_INPUT` 并列出缺失项。
- **工具**：T-006 `suggest_line_price`（只调内核，复用 Track A 的定价继承与管控夹取），与既有 T-001/T-002/T-003/T-004/T-005 一起通过 Zod 校验。
- **LiteLLM**：`platform/llm.ts` 的 `LiteLlmProvider` 只请求 `LITELLM_BASE_URL/chat/completions`；
  `key_ref` 解析每租户虚拟 Key，模型白名单 + 日/月 token 预算在调用前拦截；手机号/邮箱/银行账号出网前脱敏。
- **计量**：`token_usage`（`request_id` 唯一，幂等）+ `usage_monthly`（按月份 × 模型 × 任务累加）；
  prompt 只落 SHA-256，默认不落原文。
- **设置**：`llm_settings` 一行 GLOBAL + 每租户覆盖；默认 `deepseek-chat`（日常）/ `deepseek-reasoner`（复杂）。
- **验收**：`pnpm demo:quote` 与 `apps/api/test/{quote-agent,llm-litellm,quote.integration}.test.ts`。

详见 `docs/track-b-agents.md`。

## 手工录入客户回复（WAN-122）

真实渠道（企微 / WhatsApp / 邮件 IMAP / 物流 API）需要企业主体资质，已拍板暂缓。
生产路径只有两路手工录入：**粘贴文本** 或 **上传聊天截图**。

- **入口**：客户 360 的「录入客户回复」（`apps/web/src/inbound-reply-drawer.tsx`），
  截图先压缩、`POST /api/media/presign`（`purpose=inbound`）直传对象存储，再提交 `objectKey`。
- **落库**：`POST /api/inbound/replies` → `inbound_messages`（幂等键
  `(tenant_id, channel, external_id)`），入库前脱敏；同一 `externalId` 重复提交返回首次识别结果，
  不会重复生成报价草稿。
- **识别**：与跟进图同一个 LLM provider（`classifyReply`）；截图走 `qwen-vl-plus`
  多模态模型（`SCREENSHOT_OCR`，token 进同一 reserve/settle 计量）。
- **报价**：识别为询价且选择了面料时，复用 T-006 定价 + T-004 草稿，停在 `DRAFT` 等人类审批；
  草稿备注写明来源消息 id，审批卡可溯源。
- **时间线**：`inbound_messages` 合并进客户 360 时间线（`kind=inbound_reply`）。
- **合规**：原始 payload 默认保留 30 天（`INBOUND_RAW_RETENTION_DAYS`），
  定时执行 `pnpm --filter @weave-order/api maintain:inbound` 清空过期 `raw_payload`（业务行保留）。
- **截图前置依赖**：截图识别必须启用 LiteLLM + DashScope key；`local-rule` 会明确报错，
  不会假装识别。已有租户若自定义过模型白名单，迁移 0018 会把 `qwen-vl-plus` 补进白名单。
