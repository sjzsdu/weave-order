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
| 智能体编排   | LangGraph.js（工具调用走 Zod 校验）                              |
| 前端         | React 18 + TypeScript + Vite + Zustand + Radix UI + Tailwind CSS |
| 校验         | Zod（工具输入输出、API 请求响应、环境变量的唯一契约来源）        |
| 测试         | Vitest（单元 + 内核集成）+ Playwright（端到端，后续）            |

## 目录结构（Monorepo，pnpm workspace + Turborepo）

```
weave-order/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── kernel/      # 确定性内核：唯一可写业务表的代码
│   │   │   ├── tools/       # 工具接口层：智能体唯一可调用的入口
│   │   │   ├── platform/    # 配置、数据库、Redis
│   │   │   ├── agent/       # 智能体编排层（第三步，只调 tools）
│   │   │   └── approval/    # 审批队列（第五步）
│   │   ├── scripts/         # demo-kernel.ts 验收演示
│   │   └── test/            # 边界回归 / 单元 / 内核集成测试
│   └── web/                 # React 18 + Vite
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

# 3. 一条命令：应用迁移 + 跑通内核演示
pnpm demo
```

`pnpm demo` 会依次展示：

1. 内核建客户（业务表 + 同事务审计写入）
2. 内核建样品（带成本底线）
3. 智能体通过工具 T-005 创建寄样单 —— 只能得到 `DRAFT`
4. 智能体调用确认 → 内核拒绝 `PERMISSION_DENIED`；人类确认 → `CONFIRMED`
5. 智能体通过工具 T-004 生成报价草稿 —— 金额由内核整数计算
6. 低于成本底线的报价 → 内核拒绝 `PRICE_BELOW_COST_FLOOR`
7. 审计日志逐条列出（谁、对哪个实体、做了什么）
8. 数据库触发器拒绝修改审计日志

不需要 `.env`（默认值与 `docker-compose.yml` 一致）；需要覆盖时 `cp .env.example .env`。

### 常用命令

```bash
pnpm build        # 构建
pnpm dev          # 本地开发（web: localhost:5173，api 目前无路由）
pnpm lint         # 全仓 ESLint（含目录边界规则）
pnpm typecheck    # 全仓类型检查
pnpm test         # 单元 + 边界测试；有本地 PG 时内核集成测试自动启用
pnpm db:generate  # 改完 Drizzle Schema 后生成 SQL 迁移
pnpm db:migrate   # 应用迁移
pnpm demo         # 迁移 + 内核验收演示
pnpm format       # Prettier
```

## 架构铁律（不可违反）

1. **确定性内核与智能体外壳分离**：智能体永远不直接修改库存数量、应收金额、合同状态等业务账本；所有涉及账本和资金的动作必须通过确定性内核的工具接口执行，并写入审计日志。
2. **智能体输出一律是「草稿 / 建议」**：人类在审批窗口确认后，前端调用内核 confirm 接口才正式生效。
3. **每个业务能力以工具（Tool）形式暴露**：工具输入输出有严格 Schema 校验；智能体不「打开页面」，只调用工具。
4. **人类界面只有三个窗口**：任务派发（Intent Bar）、审批与异常分诊（Review Queue）、业务全景只读视图（Read-Only Panorama）。

### 铁律在代码与数据库里的落点

| 铁律           | 落地方式                                                                                               | 可验证点                                               |
| -------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 智能体不改账本 | 只有 `apps/api/src/kernel` 能写入业务表；工具层只拿到 `Kernel` 对象，拿不到 `Db`                       | `eslint.config.mjs` + `apps/api/test/boundary.test.ts` |
| 越权路径封死   | agent 禁止 import kernel / drizzle-orm / pg / `@weave-order/db`；tools / approval 禁止直连数据库       | 同上，含裸 barrel `../kernel`                          |
| 输出必须是草稿 | 内核 `createDraft` 强制 `DRAFT`；`confirm*` 校验 `actor.type === "HUMAN"`                              | 演示 ④⑤⑧、内核集成测试                                 |
| 金额不可伪造   | 金额一律整数「分」；行金额由内核整数运算 + 一次 half-up 舍入；`amountsComputedByKernel: true` 契约断言 | `packages/schema`、`apps/api/src/kernel/money.ts`      |
| 改账必须留痕   | 业务写入与审计写入同一事务；`audit_log` 由数据库触发器禁止 UPDATE / DELETE                             | 演示 ⑨⑩、内核集成测试                                  |
| 契约唯一来源   | 所有 Zod Schema 只在 `packages/schema`；数据库枚举与契约枚举由测试比对                                 | `apps/api/test/schema-parity.test.ts`                  |

## 目录边界铁律

- `apps/api/src/kernel/` 下的 service 是唯一可以写业务表的代码。
- `apps/api/src/tools/` 只调用 kernel 的 service，不直接连数据库。
- `apps/api/src/agent/` 只调用 tools/ 的接口，不 import kernel/ 的任何模块，也不触达数据库。**已用 ESLint `no-restricted-imports` 强制**（`eslint.config.mjs`，覆盖 `**/kernel`、`**/kernel/**` 与数据库相关 import），并有常驻回归测试（`apps/api/test/boundary.test.ts`）锁定。
- `packages/schema/` 的 Zod Schema 是前后端和工具层的唯一契约来源，不重复定义。

## 契约设计（packages/schema）

`packages/schema` 是前后端、工具层与内核的**唯一契约来源**：

- `src/common.ts` — 工具层统一失败语义：以 `code` 区分的可判别联合（discriminated union），调用方可 `switch (error.code)` 精确分流。
- `src/domain.ts` — 领域实体：Customer、CustomerContext、FabricSample、SampleShipment、Money、Quantity、DecisionDelta 等。
- `src/kernel.ts` — 内核输入契约（CreateCustomer / CreateSample / CreateSampleShipment / Confirm…）与审计日志读取模型。全部 `.strict()`：未知字段一律拒绝。
- `src/tools/t003-get-customer-history.ts` — T-003 输入 / 输出 / 失败语义。
- `src/tools/t004-generate-quote-draft.ts` — T-004 输入 / 输出 / 失败语义。
- `src/tools/t005-create-sample-shipment.ts` — T-005 输入 / 输出 / 失败语义。

关键约束：

- **金额以整数「分」表示**，禁止浮点；数量以「千分之一单位」整数存储。
- **报价草稿 `amountsComputedByKernel` 契约级断言为 `true`**。
- **输入 `.strict()`**：契约宁可拒，智能体不能夹带 `status`、`version` 等账本字段。
- **不留 `any`**：`no-explicit-any: error`，异构值用带类型的递归 `JsonValue`。

## 数据模型（第二步）

`packages/db/src/schema/`：

| 表                                           | 说明                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `customers`                                  | 客户主表，`version` 支持乐观并发                                           |
| `customer_contexts`                          | 客户私有上下文（护城河）：选样偏好、报价行为、付款行为、跟进偏好、决策增量 |
| `samples`                                    | 面料样品，含报价成本底线（整数分）                                         |
| `sample_shipments` / `sample_shipment_items` | 寄样单与明细，状态 DRAFT → CONFIRMED                                       |
| `quotes` / `quote_items`                     | 报价单与明细，行金额/总额由内核计算                                        |
| `audit_log`                                  | 追加型审计日志，数据库触发器禁止 UPDATE / DELETE                           |

迁移在 `packages/db/drizzle/`，由 `drizzle-kit generate` 生成、`pnpm db:migrate` 应用。

## 本轮范围

第二步（确定性内核骨架）已完成：

- Customer / Sample / SampleShipment / Quote 的 Drizzle Schema、Service 与同事务审计日志。
- 工具 T-003 / T-004 / T-005 的 Zod 契约与工具实现（智能体唯一入口）。
- 本地 PostgreSQL + Redis 编排与一条命令的验收演示。
- 内核边界（ESLint + 回归测试）、金额确定性、审计不可篡改均有可执行验证。

未做（后续步骤）：智能体编排（LangGraph）、审批队列 API、前端三个窗口、Excel/CSV 导入。
