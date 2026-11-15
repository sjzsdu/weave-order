# 客户归属与数据范围（WAN-106）

本文锁定 `dataScope` 之外的「归属人」语义。权限过滤本身见
`apps/api/src/kernel/data-scope.ts`（WAN-99），这里只回答：**`customers.owner_id` 写谁、NULL 怎么处理、演示/历史/智能体数据怎么归属。**

## 1. 唯一事实

- `customers.owner_id` 存的是 `memberships.id`，不是 Casdoor `sub`。
- 人类经网关写入时，`HumanActorService` 用 `humanScopeOf(membership)` 注入
  `ctx.ownerId = membership.id`；内核 `CustomerService.insertWithin` 落
  `ownerId: ctx.ownerId ?? null`。
- `quotes` / `samples` / `receivables` / `shipments` 不单独存负责人，它们的可见性
  一律 join `customers` 用 `customers.ownerId` 判定。

## 2. NULL 的语义（方案 A，不回填就看不到）

`owner_id IS NULL` 表示「无归属人」。判定保持 WAN-99 的 fail-closed：

| dataScope      | `owner_id IS NULL` 的客户   |
| -------------- | --------------------------- |
| `OWN`          | 不可见（含 OWNER 角色成员） |
| `TEAM`         | 不可见                      |
| `ALL`          | 可见                        |
| 无 `dataScope` | 可见（内核/系统内部路径）   |

没有采用「无归属数据对 OWNER/MANAGER 可见」的方案 B，原因是它会让同一份数据
对 SALES 与 MANAGER 语义分裂，且把权限判断塞进角色维度；方案 A 用一次性回填
把数据修正，可见性规则保持一条。**代价**：升级后必须跑一次回填（见 §3）。

## 3. 历史数据回填

```bash
pnpm db:backfill-owner              # 只读：每租户条数 / 目标 OWNER / 回滚语句
pnpm db:backfill-owner -- --apply   # 单事务执行
pnpm db:backfill-owner -- --tenant=<uuid> [--apply]  # 只处理一个租户
```

规则只有一条：`owner_id IS NULL` → 该租户**最早创建的 ACTIVE OWNER 成员**。

- 多个 OWNER 时选最早创建的一个，并在报告里打印候选数量。
- 没有 ACTIVE OWNER 的租户不猜归属：报告列出、跳过，命令以非 0 退出。
- `--apply` 是单事务，失败整体回滚；打印的回滚语句可把归属恢复为 NULL
  （>100 行时按「租户 + 负责人 + 事务时间戳」匹配，避免刷屏）。
- 只回填 `customers`：其它单据的归属随客户，客户补齐后一并恢复可见。

## 4. seed / demo 数据

`pnpm seed` 与 `pnpm demo` 通过 `apps/api/scripts/demo-identity.ts` 幂等确保演示租户里
存在 7 个角色成员，并把演示数据挂到**演示业务员**：

| 成员 subject（默认） | 角色         | dataScope | 用途 / 本地 dev 令牌                   |
| -------------------- | ------------ | --------- | -------------------------------------- |
| `demo`               | OWNER        | `ALL`     | 全量；`dev:demo:demo`                  |
| `demo-manager`       | MANAGER      | `TEAM`    | 与 `demo-sales` 同 team，看本组        |
| `demo-sales`         | SALES        | `OWN`     | seed 数据负责人；`dev:demo-sales:demo` |
| `demo-merchandiser`  | MERCHANDISER | `TEAM`    | 跟单执行岗                             |
| `demo-sample-admin`  | SAMPLE_ADMIN | `TEAM`    | 样品维护（含成本底线）                 |
| `demo-finance`       | FINANCE      | `ALL`     | 应收工作面，全景不显示订单入口         |
| `demo-viewer`        | VIEWER       | `ALL`     | 只读席位                               |

这份清单的唯一事实源是 `packages/schema/src/personas.ts`：seed、dev 切换端点
（`/api/dev/personas`、`/api/dev/session`）、前端身份条（⌘⇧I）与 e2e 夹具都读它，
不另抄角色表。经理与业务员必须同一个 `teamId`，否则 `TEAM` 范围退化为「本人」，
切到经理会看到空列表。

为什么挂 SALES 而不是 OWNER：验收要求「`dataScope=OWN` 的 SALES 能看到 seed 客户」，
只有负责人就是该 SALES 成员才成立；OWNER 用 `ALL` 照样看全量。

可用环境变量覆盖：`SEED_TENANT_ID`（默认内置演示租户）、`SEED_ORG`（默认 `demo`）。
persona 的 subject / 角色 / 范围由目录固定；dev 身份不走 Casdoor，生产/OIDC 镜像里
`/api/dev/*` 路由不存在（404，不是 403）。

> 在已有数据的库上重跑 seed 仍受 `DUPLICATE_IN_DB` 保护；要用新归属覆盖旧行请
> `SEED_RESET=1 pnpm seed`（同事务重置 seed 行）。

## 5. 智能体创建的客户

- 智能体上下文本身不带 `dataScope`，内部读路径不受限；写客户时归属
  `ctx.ownerId`。
- **替某个业务员干活**（从某人的意图/会话派发）时，派发方必须把该业务员的
  `membership.id` 放进 `KernelContext.ownerId`。否则客户 `owner_id` 为 NULL，
  在 `OWN` 视图里谁都看不到（只有 `ALL` 成员能看到）。
- 当前没有「智能体建客户」工具；新增时按上一条注入 ownerId
  （参见 `apps/api/test/owner-backfill.integration.test.ts` 的用例）。
- 纯系统/批处理产生的无归属客户，仍需 §3 的回填才会进入某个 OWNER 名下。
