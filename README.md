# 织序 WeaveOrder

纺织贸易的智能体原生业务操作系统。智能体（Agent）是系统的默认操作者，人类只负责审批结果和处理异常。

竞品（布管家、珍妮软件）的架构前提是「业务员是操作者」；织序的前提是「智能体是操作者」。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 后端 | NestJS + TypeScript |
| 数据库 | PostgreSQL + pgvector |
| ORM / 查询层 | Drizzle ORM（TypeScript 优先） |
| 缓存与队列 | Redis |
| 智能体编排 | LangGraph.js（工具调用走 Zod 校验） |
| 前端 | React 18 + TypeScript + Vite + Zustand + Radix UI + Tailwind CSS |
| 校验 | Zod（工具输入输出、API 请求响应、环境变量的唯一契约来源） |
| 测试 | Vitest（单元）+ Playwright（端到端） |

## 目录结构（Monorepo，pnpm workspace + Turborepo）

```
weave-order/
├── apps/
│   ├── api/          # NestJS 后端
│   │   └── src/       # kernel / tools / agent / approval / platform（后续步骤）
│   └── web/          # React 18 + Vite 前端（Web + H5 按路由区分）
├── packages/
│   ├── schema/       # Zod Schema：工具输入输出、API 契约（前后端唯一契约来源）
│   ├── db/           # Drizzle ORM Schema 与迁移
│   └── shared/       # 公共类型与工具函数
├── migrations/
├── turbo.json
├── pnpm-workspace.yaml
└── README.md
```

## 初始化命令

```bash
# 1. 安装 pnpm（若未安装）
corepack enable

# 2. 安装依赖
pnpm install

# 3. 常用命令
pnpm build       # 构建（turbo run build）
pnpm dev         # 开发（turbo run dev）
pnpm lint        # 全仓 lint（eslint .）
pnpm typecheck   # 全仓类型检查（turbo run typecheck）
pnpm test        # 单元测试（turbo run test）
pnpm format      # 格式化
```

## 架构铁律（不可违反）

1. **确定性内核与智能体外壳分离**：智能体永远不直接修改库存数量、应收金额、合同状态等业务账本；所有涉及账本和资金的动作必须通过确定性内核的工具接口执行，并写入审计日志。
2. **智能体输出一律是「草稿 / 建议」**：人类在审批窗口确认后，前端调用内核 confirm 接口才正式生效。
3. **每个业务能力以工具（Tool）形式暴露**：工具输入输出有严格 Schema 校验；智能体不「打开页面」，只调用工具。
4. **人类界面只有三个窗口**：任务派发（Intent Bar）、审批与异常分诊（Review Queue）、业务全景只读视图（Read-Only Panorama）。

## 目录边界铁律

- `apps/api/src/kernel/` 下的 service 是唯一可以写业务表的代码。
- `apps/api/src/tools/` 只调用 kernel 的 service，不直接连数据库。
- `apps/api/src/agent/` 只调用 tools/ 的接口，不 import kernel/ 的任何模块。**这条边界已用 ESLint `no-restricted-imports` 强制**（`eslint.config.mjs`，覆盖 `**/kernel` 与 `**/kernel/**`，含裸 barrel 导入），并有常驻回归测试（`apps/api/test/boundary.test.ts`）锁定。
- `packages/schema/` 的 Zod Schema 是前后端和工具层的唯一契约来源，不重复定义。

## 契约设计（packages/schema）

`packages/schema` 是前后端与工具层的**唯一契约来源**：

- `src/common.ts` — 工具层统一失败语义：以 `code` 区分的可判别联合（discriminated union），调用方可 `switch (error.code)` 精确分流。
- `src/domain.ts` — 领域实体 Schema（Customer、CustomerContext、Money、Quantity、DecisionDelta 等）。
- `src/tools/t003-get-customer-history.ts` — T-003 工具输入 / 输出 / 失败语义。
- `src/tools/t004-generate-quote-draft.ts` — T-004 工具输入 / 输出 / 失败语义。

关键约束：

- **金额以整数「分」表示**，禁止浮点，杜绝精度问题，也让「金额只能由确定性内核计算」在类型层可判别（`Money.amount = z.number().int()`）。
- **报价草稿 `amountsComputedByKernel` 契约级断言为 `true`**，金额来源不可判别即被 Schema 拒绝。
- **不留 `any`**：异构值（决策增量 before/after）用带类型的递归 `JsonValue` 联合表示。

## 本轮范围（第一步）

只交付 Monorepo 骨架与契约设计：

- 初始化命令、各 workspace `package.json`、`turbo.json`。
- `packages/schema` 中 T-003 / T-004 的 Zod Schema（输入、输出、失败语义）及单元测试。

内核、编排层、Drizzle Schema、前端三个窗口留待后续步骤。
