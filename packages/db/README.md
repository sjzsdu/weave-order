# @weave-order/db · 数据库迁移与修复手册

租户库的唯一入口：Drizzle schema、SQL 迁移、RLS 策略。本文是迁移纪律与存量库修复（WAN-98）的操作手册。

## 命令一览

| 命令                                                        | 作用                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm db:generate`                                          | 改完 Drizzle Schema 后生成新迁移（**唯一**合法的迁移变更方式）     |
| `pnpm db:migrate`                                           | 应用迁移 + 幂等套用 `sql/rls.sql`                                  |
| `pnpm db:repair`                                            | 存量库体检：只读打印对齐计划与回滚语句，**不写库**                 |
| `pnpm db:repair -- --apply`                                 | 单事务执行对齐计划（补记录 / 改时间戳 / 直接执行被水位挡住的迁移） |
| `pnpm db:check`                                             | 验收：库必须已迁移到 HEAD，且记录与 journal 完全一致（CI 用）      |
| `pnpm --filter @weave-order/db migrate:guard -- <base-ref>` | 迁移纪律守卫：已合并迁移/journal 被改写则红（`skip` 跳过）         |

## 迁移纪律（append-only，CI 强制）

**机制事实**（drizzle-orm 0.45.4 `pg-core/dialect.cjs` 的 `migrate()`）：
是否重放某条迁移，只看 `drizzle.__drizzle_migrations.created_at` 的最大值与 journal 条目
`when` 的大小——`when > max(created_at)` 就按 journal 顺序重放该条及之后的迁移；
`hash` 只写入、**不参与判定**。

因此：

1. **已合并的 `drizzle/*.sql` 文件不可改写、不可删除**；需要变更就 `pnpm db:generate` 新增迁移。
2. **`meta/_journal.json` 中既有条目的 `tag` / `when` / `idx` 不可变**——`when` 一变，
   drizzle 就会重放它之后的所有迁移，存量库撞上 `type/table already exists` 卡死（WAN-98 的根因）。
3. 迁移文件与 journal 条目必须同一 PR 原子提交（`drizzle-kit generate` 自动成对生成）。
4. 新增迁移优先 `IF NOT EXISTS` 幂等写法；不依赖隐式执行顺序。

强制手段：

- **本地/CI 守卫**：`pnpm --filter @weave-order/db migrate:guard -- origin/main`，
  改写或删除已合并迁移立即非 0 退出。
- **CI 升级演练**（`.github/workflows/ci.yml` 的 `migrate-upgrade` job，每次 PR 运行）：
  守卫通过后，先按基线（PR 的 base）的 `drizzle/` + `sql/` 迁移出「上一个已发布修订」的库，
  再恢复 PR 头执行一次增量迁移，最后 `migrate:check` 验收——新增迁移必须能从旧库升级上来。

## 存量库修复手册（`pnpm db:repair`）

### 症状与根因

`pnpm db:migrate` 在**已迁移过**的库上报：

```text
✖ 迁移失败： CREATE TYPE "public"."pricing_scope_type" ... ← type "pricing_scope_type" already exists
```

典型成因（历史遗留，WAN-98 之前没有守卫）：迁移文件或 journal 的 `when` 在应用之后被改写 /
漏记记录，导致 drizzle 认为该迁移「还没应用过」而重放它。记录与库的真实状态从此漂移，
后续所有迁移都被卡死。

### 三步走

```bash
# 1. 只读体检：打印每个迁移的状态、将执行的动作、回滚语句。不写库。
pnpm db:repair

# 2. 审阅计划（见下表）。有「阻断问题」时退出码为 1，不会做任何修改——按提示人工处理。

# 3. 确认后执行（单事务：任何一步失败全部回滚），随后验收：
pnpm db:repair -- --apply
pnpm db:migrate     # 应为无操作（记录已对齐，没有待应用迁移）
pnpm db:check       # 应通过：8/8 与 journal 一致
```

### 状态含义

| 状态                              | 含义                                                 | 工具动作                                                                     |
| --------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| ✔ 已对齐                          | 记录、对象、时间戳三者一致                           | 无                                                                           |
| ⚠ 无记录                          | 对象状态与迁移断言逐条一致，但缺记录（文件被改写过） | `INSERT` 补记录                                                              |
| ⚠ 时间戳漂移                      | 记录存在但 `created_at` ≠ journal `when`             | `UPDATE` 改时间戳                                                            |
| · 未应用                          | 对象完全缺失                                         | `when` 在水位之后 → 留给正常迁移；**在水位之前（水位空洞）→ 单事务直接执行** |
| ✖ 只应用了一半 / 记录在但对象缺失 | 库的状态无法与任何迁移历史对上                       | **阻断**，人工决定                                                           |
| ? 无法核验                        | 迁移里只有 INSERT/DO 等无法逐条核验的语句            | 有记录则只提示；挡在水位空洞里则**阻断**                                     |

### 安全门（什么时候它会拒绝干活）

- 「只应用了一半」「记录在但对象缺失」「孤立记录的时间戳会吞掉待应用迁移」——一律非 0 退出、拒绝写入，报告里写明人工处理路径；
- 水位空洞迁移若含无法核验的语句（`INSERT` / `DO` 块等），不代执行——报错交给人；
- `--apply` 是**单事务**，失败自动整体回滚；报告同时打印每一步的回滚 SQL
  （含为直接执行的迁移生成的 `DROP ...` 语句），可原样执行恢复。

### 它不做什么

- 不改写任何迁移文件、不删库重建、不动业务数据——只改 `drizzle.__drizzle_migrations` 的记录，
  外加执行「从未执行过、且永远轮不到 drizzle 执行」的纯 DDL 迁移；
- 不替你掩盖漂移：对象被人删过的情况一律报错，补对象还是新增补丁迁移由人决定。

## 生产发布：迁移是部署的一部分，不是可选项

**镜像和数据是两条独立轨道。** 只换镜像不跑迁移，进程会照常启动、健康检查照常 200，
只有碰到新表的那条查询 500。2026-11-17 生产就是这样：`0019_true_old_lace.sql` 没执行，
`intents` 表不存在，「说点什么」整条意图闭环（GET/POST `/api/intents`）连续返回 500，
而 `/api/health` 一直显示正常，从发布到发现隔了几个小时。

发布顺序（每一步都不跳）：

```bash
# 1. 迁移（compose 里的 migrate 服务，或直接跑）
 docker compose run --rm migrate
#   等价：pnpm --filter @weave-order/db migrate

# 2. 验收：库结构必须与 journal 完全一致，否则不要切流量
 docker compose run --rm migrate pnpm db:check
#   等价：pnpm db:check（= pnpm --filter @weave-order/db migrate:check）

# 3. 起 api/web，然后看健康检查的 schema 字段
 curl -s https://app.wnbgj.com/api/health
# 期望：{"ok":true,"database":"up","schema":{"state":"ok","missing":[]}}
```

判读：

| 现象                                  | 含义                   | 处理                               |
| ------------------------------------- | ---------------------- | ---------------------------------- |
| `schema.state = "behind"`             | 有表没建，迁移漏跑     | 回到第 1 步，不要继续发布          |
| `schema.missing` 非空                 | 上面缺的具体表名       | 同上；表名直接对应漏掉的迁移       |
| 启动日志 `数据库结构落后：缺少 …`     | 同上（启动时会主动打） | 同上                               |
| 接口返回 503 `DB_SCHEMA_NOT_MIGRATED` | 请求撞上了不存在的表   | 同上；前端会显示人话原因而不是 500 |

更彻底的做法：部署机的 compose 给 api 加上 `WEAVE_REQUIRE_SCHEMA_AT_BOOT=1`，
且 `depends_on: migrate: condition: service_completed_successfully`。缺表时 api 直接拒绝启动，
一次发布失败而不是一个悄悄坏掉的功能。**注意**：若 compose 没有把 migrate 排在 api 前面，
这个开关会把「一个功能坏」变成「整站起不来」，启用前先确认启动顺序。

## 验收标准

- 存量库：`pnpm db:repair -- --apply` 后 `pnpm db:migrate` 成功、`pnpm db:check` 通过、新迁移对象（如 `print_jobs`）齐备；
- 全新库：`pnpm db:migrate` 一次到位（38 张迁移表）、`pnpm db:check` 通过；
- PR：`migrate-upgrade` job 绿；改写已合并迁移或写坏新迁移时必须红。
