# 织序 WeaveOrder

纺织贸易的智能体原生业务操作系统。智能体（Agent）是系统的默认操作者，人类只负责审批结果和处理异常。

竞品（布管家、珍妮软件）的架构前提是「业务员是操作者」；织序的前提是「智能体是操作者」。

## 技术栈

| 层           | 选型                                                             |
| ------------ | ---------------------------------------------------------------- |
| 后端         | NestJS + TypeScript                                              |
| 数据库       | PostgreSQL 16 + pgvector                                         |
| ORM / 查询层 | Drizzle ORM（TypeScript 优先）                                   |
| 缓存与队列   | Redis 7                                                          |
| 向量检索     | MVP：`real[]` + 应用内 cosine；上量后切 pgvector `vector` + HNSW |
| 智能体编排   | LangGraph.js（工具调用走 Zod 校验，后续）                        |
| 前端         | React 18 + TypeScript + Vite（Web + H5 按路由区分）              |
| 校验         | Zod（工具输入输出、API 请求响应、环境变量的唯一契约来源）        |
| 测试         | Vitest（单元 + 内核/HTTP 集成）+ Playwright（端到端，后续）      |

## 目录结构（Monorepo，pnpm workspace + Turborepo）

```
weave-order/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── kernel/      # 确定性内核：唯一可写业务表的代码（含找样检索）
│   │   │   ├── tools/       # 工具接口层：智能体唯一可调用的入口
│   │   │   ├── http/        # 最小 HTTP 面：目录、工具、确认、审计
│   │   │   ├── platform/    # 配置、数据库、Redis、embedding provider
│   │   │   ├── agent/       # 智能体编排层（后续，只调 tools）
│   │   │   └── approval/    # 审批队列（后续）
│   │   ├── scripts/         # demo-kernel.ts 验收演示
│   │   └── test/            # 边界 / 单元 / 内核集成 / HTTP e2e
│   └── web/                 # React 18 + Vite（只读页面 + 一个按钮）
├── packages/
│   ├── schema/              # Zod 契约（前后端 / 工具 / 内核唯一来源）
│   └── db/                  # Drizzle Schema、连接、SQL 迁移
├── docker-compose.yml       # PostgreSQL + pgvector、Redis
├── turbo.json
└── pnpm-workspace.yaml
```

## 本地运行

```bash
# 1. 依赖
corepack enable
pnpm install

# 2. 起本地 PG + Redis（端口 5433 / 6380，避免与本机已有服务冲突）
docker compose up -d

# 3. 应用迁移 + 跑通内核演示（会写入演示客户/样品，页面需要这些数据）
pnpm demo

# 4. 打开能点的页面（API 3000 + Vite 5173）
pnpm dev
# → http://localhost:5173
```

页面是**只读 + 一个按钮**：左侧选样品，点「让智能体生成报价草稿」，右侧出现
`DRAFT` 报价卡片与审计流水。页面不会替人类确认 —— 这是有意的（铁律 #2）。

`demo` 逐项展示：

1. 内核建客户（业务表 + 同事务审计写入）
2. 内核建样品（带成本底线）
3. 智能体通过工具 T-005 创建寄样单 —— 只能得到 `DRAFT`
4. 智能体调用确认 → 内核拒绝 `PERMISSION_DENIED`；人类确认 → `CONFIRMED`
5. 智能体通过工具 T-004 生成报价草稿 —— 金额由内核整数计算
6. 低于成本底线的报价 → 内核拒绝 `PRICE_BELOW_COST_FLOOR`
7. 找样工具 T-002（参数匹配）/ T-001（以图搜图，local stub embedding）
8. 审计日志逐条列出，数据库触发器拒绝改写

不需要 `.env`（默认值与 `docker-compose.yml` 一致）；需要覆盖时 `cp .env.example .env`。
演示**不依赖任何外部模型 key**：embedding 默认走 `local-stub`，真实 provider 在
`apps/api/src/platform/embedding.ts` 的接口后面，接入时只换 provider。

### 常用命令

```bash
pnpm build        # 构建
pnpm dev          # api(3000) + web(5173)
pnpm lint         # 先构建契约包，再跑全仓 ESLint（含目录边界规则）
pnpm typecheck    # 全仓类型检查
pnpm test         # 单元 + 边界；有本地 PG 时内核/HTTP 集成测试自动启用
pnpm db:generate  # 改完 Drizzle Schema 后生成 SQL 迁移
pnpm db:migrate   # 应用迁移
pnpm demo         # 迁移 + 内核验收演示
pnpm format       # Prettier
```

### 最小 HTTP 面

| 方法 | 路径                              | 说明                             |
| ---- | --------------------------------- | -------------------------------- |
| GET  | `/api/health`                     | 服务 + 数据库可用性              |
| GET  | `/api/customers`                  | 客户列表（页面演示用）           |
| GET  | `/api/samples`                    | 样品目录（只读）                 |
| POST | `/api/tools/search-by-spec`       | T-002 参数匹配                   |
| POST | `/api/tools/search-by-image`      | T-001 以图搜图（base64）         |
| POST | `/api/tools/generate-quote-draft` | T-004 生成报价草稿（agent 身份） |
| POST | `/api/quotes/:quoteId/confirm`    | 人类确认报价草稿（DRAFT → SENT） |
| GET  | `/api/audit`                      | 审计流水（只读）                 |

## 架构铁律（不可违反）

1. **确定性内核与智能体外壳分离**：智能体永远不直接修改库存数量、应收金额、合同状态等业务账本；所有涉及账本和资金的动作必须通过确定性内核的工具接口执行，并写入审计日志。
2. **智能体输出一律是「草稿 / 建议」**：人类在审批窗口确认后，前端调用内核 confirm 接口才正式生效。
3. **每个业务能力以工具（Tool）形式暴露**：工具输入输出有严格 Schema 校验；智能体不「打开页面」，只调用工具。
4. **人类界面只有三个窗口**：任务派发（Intent Bar）、审批与异常分诊（Review Queue）、业务全景只读视图（Read-Only Panorama）。

### 铁律在代码与数据库里的落点

| 铁律           | 落地方式                                                                                                       | 可验证点                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 智能体不改账本 | 只有 `apps/api/src/kernel` 能写入业务表；工具层只拿到 `Kernel` 对象，拿不到 `Db`                               | `eslint.config.mjs` + `apps/api/test/boundary.test.ts` |
| 越权路径封死   | agent 禁止 import kernel / drizzle-orm / pg / `@weave-order/db`；tools / approval 禁止直连数据库               | 同上，含裸 barrel `../kernel`                          |
| 输出必须是草稿 | 内核 `createDraft` 强制 `DRAFT`；`confirm*` 校验 `actor.type === "HUMAN"`                                      | demo、内核/HTTP 集成测试                               |
| 金额不可伪造   | 金额一律整数「分」，PG `bigint` 存储；行金额用 BigInt 计算再一次 half-up；契约层 `Money.max(MAX_SAFE_INTEGER)` | `packages/schema`、`apps/api/src/kernel/money.ts`      |
| 改账必须留痕   | 业务写入与审计写入同一事务；`audit_log` 由数据库触发器禁止 UPDATE / DELETE                                     | demo、内核集成测试                                     |
| 契约唯一来源   | 所有 Zod Schema 只在 `packages/schema`；数据库枚举与契约枚举由测试比对                                         | `apps/api/test/schema-parity.test.ts`                  |
| 检索可替换     | embedding 是 provider 接口，默认 local stub，不需要模型 key                                                    | `apps/api/src/platform/embedding.ts`                   |

## 目录边界铁律

- `apps/api/src/kernel/` 下的 service 是唯一可以写业务表的代码。
- `apps/api/src/tools/` 只调用 kernel 的 service，不直接连数据库。
- `apps/api/src/agent/` 只调用 tools/ 的接口，不 import kernel/ 的任何模块，也不触达数据库。**已用 ESLint `no-restricted-imports` 强制**（`eslint.config.mjs`），并有常驻回归测试（`apps/api/test/boundary.test.ts`）锁定。
- `packages/schema/` 的 Zod Schema 是前后端和工具层的唯一契约来源，不重复定义。

## 契约设计（packages/schema）

- `src/common.ts` — 统一失败语义：以 `code` 区分的可判别联合，调用方可 `switch (error.code)` 精确分流。
- `src/domain.ts` — 领域实体：Customer、CustomerContext、FabricSample、SampleShipment、Money、Quantity、JsonValue 等。
- `src/kernel.ts` — 内核输入契约与审计日志读取模型；全部 `.strict()`（未知字段一律拒绝）。
- `src/tools/t001-search-fabric-by-image.ts` — 以图搜图输入 / 输出 / 相似度范围。
- `src/tools/t002-search-fabric-by-spec.ts` — 参数匹配输入 / 输出 / `matchedOn`。
- `src/tools/t003-get-customer-history.ts` — 客户历史。
- `src/tools/t004-generate-quote-draft.ts` — 报价草稿，`amountsComputedByKernel: true`。
- `src/tools/t005-create-sample-shipment.ts` — 寄样单草稿 + 内核建议跟进时间。

关键约束：

- **金额以整数「分」表示**，DB 列为 `bigint`（Drizzle `mode: "number"`），单笔上限从 int4 的约 2147 万元提升到 90 万亿元；契约层再以 `Number.MAX_SAFE_INTEGER` 兜底。
- **数量以「千分之一单位」整数存储**，乘法用 BigInt 完成，超界显式 `KERNEL_REJECTED`。
- **输入 `.strict()`**：智能体不能夹带 `status`、`version` 等账本字段。
- **不留 `any`**：异构值用带类型的递归 `JsonValue`。

## 数据模型

| 表                                           | 说明                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `customers`                                  | 客户主表，`version` 支持乐观并发                                           |
| `customer_contexts`                          | 客户私有上下文（护城河）：选样偏好、报价行为、付款行为、跟进偏好、决策增量 |
| `samples`                                    | 面料样品，含报价成本底线（bigint 分）                                      |
| `sample_shipments` / `sample_shipment_items` | 寄样单与明细，DRAFT → CONFIRMED                                            |
| `quotes` / `quote_items`                     | 报价单与明细，金额 bigint，行金额/总额由内核计算                           |
| `sample_embeddings`                          | 样品向量索引（model + dimension + `real[]`），创建样品时写入               |
| `audit_log`                                  | 追加型审计日志，数据库触发器禁止 UPDATE / DELETE                           |

迁移在 `packages/db/drizzle/`，由 `drizzle-kit generate` 生成、`pnpm db:migrate` 应用。

## 本轮范围

第三步（找样 + 报价 + 最小可点页面）已完成：

- T-001 以图搜图、T-002 参数匹配两个找样工具；embedding provider 可替换，默认 local stub。
- T-004 报价草稿接入 HTTP；金额改 `bigint` 并在契约层加 `.max()`。
- 最小 HTTP 面（目录 / 工具 / 人类确认 / 审计）+ 只读页面（一个按钮）。
- `sample_embeddings` 索引在建样品时写入；以图搜图用确定性 cosine 相似度。

未做（后续步骤）：LangGraph 编排、完整审批队列、H5 / 小程序、Excel/CSV 导入、pgvector 索引与真实 embedding provider。
