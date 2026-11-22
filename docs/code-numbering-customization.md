# 五类实体编号体系治理 · 设计文档

> 版本：v1.0 ｜ 日期：2026-11-22 ｜ 状态：已实现（T1–T5 完成，T6 收尾中）
> 范围：客户 / 样品 / 报价 / 订单 / 寄样单五类业务编号（含编号自定义）
> 已确认决策：① 覆盖全部五类实体；② 系统推荐 = 内置预设模板；③ 用户自定义 = 占位符模板串；④ 评审修订后进入开发。
> v1.0 变更：按实现结果订正 API/UI 落点、回填执行计划与验收状态；实现偏离在 §10.3、§13 明示。
>
> **v0.2 修订**（针对评审的四项地基问题 + 四项补强，逐条对应正文标注 `[R1]`–`[R9]`）：
> - `[R1]` 并发取号闭环：改为「同事务原子计数器分桶 + 唯一索引兜底」，删除事务外取号与 3 次盲重试；新增同分桶并发创建测试。
> - `[R2]` 不可变语义：收敛为「**规则变更不追溯历史编号**」，保留显式纠错改码入口并说明其与二维码的关系。
> - `[R3]` RLS：`code_rules` / `code_counters` 纳入 `rls.sql` 统一登记，补跨租户读写/覆盖集成测试。
> - `[R4]` 迁移契约：订正为「`orders` 只加唯一索引；`quotes` / `sample_shipments` 加 nullable code」，重号检查按 `(tenant_id, code)` 分组，前置检查失败即阻断迁移。
> - `[R5]` 逐实体输入契约表：明确哪些实体接受显式 code、哪些拒绝。
> - `[R6]` 性能：给出数据规模假设与执行计划验证要求，计数器分桶同时解决并发与扫描。
> - `[R7]` 冲突识别：只有命中 `*_tenant_code_idx` 才重算，草稿幂等键等其他约束原样冒泡。
> - `[R8]` 报价表述订正：历史展示兼容、新编号形态变化，不再说「零迁移风险」。
> - `[R9]` 宽度定义：区分「保存期容量预算」与「运行时硬校验」，定义进位超限行为。

---

## 0. 结论先行

把散落在四个 service 里的编号生成逻辑，收敛成**租户级可配置的「编号规则」能力**，一次把五类实体的编号体系治理到位：

- 系统给**内置预设模板**（默认 = 客户/样品现状格式），用户可在设置页一键套用或自己写**占位符模板串**（如 `KH-{YYYYMM}-{SEQ:4}`）。
- 新增 `code_rules`（规则）与 `code_counters`（取号计数器）两张表，生成逻辑统一收口到 `CodeNumberService`；五个 service 只调用它，不再各自算日期和序号。
- **[R1] 并发取号**：按「租户 + 实体 + 规则分桶」用数据库原子 UPSERT 递增计数器，**取号与业务写入在同一事务内**；唯一索引仅作最终兜底，且只有命中编号唯一索引才重算。
- **[R2] 铁律（收敛措辞）**：**规则变更不追溯历史编号**——改规则只影响之后新建的记录，已写出的编号不受影响。显式改码（`UpdateSampleInput.code`，`kernel.ts:122`）作为**纠错能力保留**，但必须走独立入口、留审计，且要提示「改码会让已发出的样卡二维码失效」（详见 §8.1）。
- **[R5] 显式 code 优先的适用范围**：仅对输入契约里**接受 code 字段**的实体（客户 / 样品 / 订单）成立；报价 / 寄样单输入是 `.strict()` 且无 code 字段，**不接受显式 code**，一律服务端生成。
- 报价编号从「派生展示值」升级为「入库可寻址编号」：**客户 / 样品新编号逐字节兼容现状；历史报价展示兼容（回退派生）；新报价编号形态发生变化**（`BJ-YYYYMMDD-XXXX` → `BJ{YYMMDD}-{SEQ:4}`）。[R8]
- 订单补唯一约束、寄样单补编号列——这两处现状有隐患（详见 §1），改造顺手修掉。

---

## 1. 现状地图（精确到文件与行）

| 实体 | 当前格式 | 生成位置 | 落库 | 唯一约束 | 问题 |
|---|---|---|---|---|---|
| 客户 | `C{YYMMDD}-{SEQ:4}` | `customers.service.ts:97` `customerCodePrefix` / `:106` `formatCustomerCode`；`createForHuman:186`、`createDraft:332` 生成 | `customers.code` NOT NULL | `customers_tenant_code_idx`；草稿另有 `customers_tenant_draft_source_idx`（`customers.ts:58`） | 硬编码；序号与写入不同事务 |
| 样品 | `S{YYMMDD}-{SEQ:4}` | `samples.service.ts:167` `sampleCodePrefix`；`createDraft:414` 生成，`create:269` 要求调用方传 code | `samples.code` NOT NULL | `samples_tenant_code_idx`；草稿另有 `samples_tenant_draft_source_idx`（`samples.ts:73`） | 同上；另有 **≤32 字节**二维码/标签约束（`share-token.ts:129`、`print/sample-card.ts:57`），中文按 3 字节 |
| 报价 | `BJ-YYYYMMDD-{id前4位大写}` | `quotes.service.ts:1971` `quoteNumberOf(row)`，**纯派生** | **无 code 列** | 无 | 不可寻址；序号是 UUID 前缀不是流水；格式变更要改函数 |
| 订单 | 调用方传入 | `orders.service.ts:162` `code: parsed.code`，**服务端不生成**；`CreateOrderInput.code` 必填（`entities.ts:58`） | `orders.code` varchar(64) **NOT NULL**（已有列） | **无唯一索引**（仅 `tenant_due_status` / `tenant_customer`） | 可重号且不报错；无自动生成 |
| 寄样单 | **无编号** | `shipments.service.ts:82` insert 不含 code | `sample_shipments` 无 code 列（`quotes.ts:32`） | 无 | 完全缺失 |

**共性痛点**：客户与样品的「北京时区校验 → 前缀 → 查当日最大序号 → 拼装 → 撞码重试 3 次 → 唯一索引兜底」是两份复制粘贴代码。而且取号（SELECT MAX）在事务内、写入也在事务内，但**两个并发事务会算出同一序号**，靠唯一索引 + 重试兜底——唯一索引保证「不写重」，不保证「并发都成功」，这是评审点名的薄弱点。本次用原子计数器消除这一竞态。

**时区纪律**：现有实现用固定 `+8h` 偏移而非 `Intl`（`customers.service.ts:95` 注释），避免运行环境 ICU 差异。新服务必须沿用，不得引入 `Intl` 或 locale 依赖。

---

## 2. 目标与非目标

**目标**
1. 管理员可在 UI 为五类实体分别配置编号模板，并看到实时示例与冲突提示。
2. 系统提供内置预设，默认格式对客户/样品逐字节一致；规则变更只影响之后新建的记录。
3. 所有编号生成收口到一处，客户/样品的重复逻辑删除。
4. 报价编号入库且对外读取统一收口；订单补唯一性；寄样单获得编号。
5. 并发安全：同一分桶的多请求创建全部成功、序号不重复。
6. 样品模板在保存时做容量预校验 + 运行时硬校验，防超限。

**非目标（本轮不做）**
- 不做 AI 生成推荐（本轮明确选内置预设）；`preset` 字段留扩展位。
- 不做「按团队/客户/品类」的继承链（编号是租户内全局标识，层级化会破坏唯一性语义）。
- 不回填历史编号；不提供批量 renumber。
- 不开放随业务字段变化的占位符（见 §5.4）。
- 不改变显式改码的业务语义，只收敛文档措辞并补审计/告警。

---

## 3. 逐实体输入契约 `[R5]`

> 这段是「显式 code 优先」的**准确边界**。评审指出文档原表述默认开发时会自动给报价/寄样单补 code 入参——实际不会，它们的输入是严格模式且无 code。

| 实体 | 创建输入契约（现状） | 未传 code | 显式传 code |
|---|---|---|---|
| 客户 | `CreateCustomerRequest.code` optional（`kernel.ts:45-47`）；`CreateCustomerInput.code` 必填（`:28`，内部 `create`） | `createForHuman:186` 走服务端生成 | **接受**：`createForHuman:188` 见 code 即转 `create()`，规则不介入 |
| 样品 | `CreateSampleInput.code` 必填（`kernel.ts:56`）；`CreateSampleDraftInput` 无 code（`:86`） | `createDraft:414` 服务端生成；`create` **不传会校验失败** | **接受**：仅 `create` 入口；`createDraft` 严格模式不收 code |
| 订单 | `CreateOrderInput.code` 必填（`entities.ts:58`） | **改造后** optional，服务端生成 | **接受**：保留现有传入路径，规则不介入 |
| 报价 | `CreateItemQuoteInput`（`item-quote.ts:19`）`.strict()`，**无 code 字段** | 服务端生成 | **拒绝**：严格模式多字段直接 400，不新增入参 |
| 寄样单 | `CreateSampleShipmentInput`（`kernel.ts:182-191`）`.strict()`，**无 code 字段** | 服务端生成 | **拒绝**：严格模式多字段直接 400，不新增入参 |

**结论**：`allocation` 对五类实体都提供「未传 → 生成」；`explicit code wins` 只对客户 / 样品 / 订单三类成立。报价 / 寄样单**永远由服务端生成**，没有显式覆盖入口。

---

## 4. 规则数据模型与 RLS

### 4.1 规则表

```ts
// packages/db/src/schema/code-rules.ts
export const codeRules = pgTable("code_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  entityType: varchar("entity_type", { length: 32 }).notNull(), // customer|sample|quote|order|sample_shipment
  template: varchar("template", { length: 128 }).notNull(),
  presetKey: varchar("preset_key", { length: 64 }),             // null = 自定义
  enabled: boolean("enabled").notNull().default(true),
  createdBy: varchar("created_by", { length: 128 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("code_rules_tenant_entity_idx").on(t.tenantId, t.entityType),
]);
```

变更历史复用现有 `audit_log`（`appendAudit`，entityType=`code_rule`），**不另建 change log 表**。

### 4.2 计数器表 `[R1]`

```ts
// 与规则表同文件或独立 code-counters.ts
export const codeCounters = pgTable("code_counters", {
  tenantId: uuid("tenant_id").notNull(),
  entityType: varchar("entity_type", { length: 32 }).notNull(),
  bucket: varchar("bucket", { length: 128 }).notNull(), // 模板渲染出的「非序号部分」，如 C261122-
  seq: bigint("seq", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.entityType, t.bucket] }),
]);
```

**分桶（bucket）定义**：模板按当前时间渲染、去掉 `{SEQ:n}` 后的字面部分。例如 `C{YYMMDD}-{SEQ:4}` 在 2026-11-22 的 bucket = `C261122-`。含义：
- 日期换天 → 自然进入新桶，序号从 1 重新起算（与现有「当日序号」语义一致）；
- 用户改规则 → 新模板渲染出的 bucket 不同（或格式变化），序号独立起算，**天然不追溯历史**（与 §0 铁律一致）；
- 计数器按桶独立递增，不同桶互不阻塞，并发只在同桶内竞争。

**为什么不用 advisory lock**：事务级 `pg_advisory_xact_lock` 也可行，但计数器方案额外提供「预览不占号 / 撞码可探测 / 可运维查看当前号段」三项能力，且与 §10 的预览接口共用同一套渲染逻辑。选计数器。

### 4.3 RLS 登记 `[R3]`

两张表都是租户配置表，必须走与业务表一致的行级隔离。**两处都要登记，漏任一处即视为未完成 T1**：

1. **Drizzle 迁移**（照 `0014_sample_text_embeddings.sql:21-25` 模式，幂等）：

```sql
ALTER TABLE "code_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "code_rules" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "code_rules";
CREATE POLICY tenant_isolation ON "code_rules"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- code_counters 同段，表名替换
```

2. **`packages/db/sql/rls.sql` 统一脚本**：在 `GRANT SELECT, INSERT, UPDATE, DELETE ON ...` 列表（约 `:29-60`）与 `business_tables` 数组（约 `:90-135`）**两处**都加入 `code_rules`、`code_counters`。漏 GRANT 会导致接口 500（项目已有 `apps/api/test/rls-grants.test.ts` 兜这类问题，本轮把新表纳入该测试）。

**读路径回退**：`CodeNumberService` 按 `(tenantId, entityType)` 取启用规则；查不到或 `enabled=false` → 回退 `classic` 预设。保证老租户 / 迁移空窗期行为不变。

---

## 5. 模板语法与校验

### 5.1 占位符白名单

| 占位符 | 含义 | 示例（北京时间 2026-11-22） |
|---|---|---|
| `{PREFIX}` | 实体默认字头 | 客户 `C`、样品 `S`、报价 `BJ`、订单 `DD`、寄样 `JY` |
| `{YY}` / `{MM}` / `{DD}` | 两位年/月/日 | `26` / `11` / `22` |
| `{YYYY}` / `{YYMMDD}` / `{YYYYMM}` / `{YYYYMMDD}` | 日期组合 | `2026` / `261122` / `202611` / `20261122` |
| `{SEQ:n}` | n 位流水，n ∈ [1,8] | `{SEQ:4}` → `0001`，第 10000 条自然进位为 `10000` |

字面量可写任意 ASCII 可打印字符（`-` `/` `.` 等）。未知占位符（如 `{CUSTOMER_NAME}`）保存时**显式拒绝**，不做静默空串替换。

### 5.2 语法约束（保存时校验）

1. `{SEQ:n}` **必须且只能出现一次**——序号槽位唯一，才能构造取号正则与 bucket。
2. 占位符必须在白名单内；字面部分只允许 ASCII 可打印字符。
3. **容量预算宽度** ≤ 64 字节：字面量字节 + 各占位符最大字节（`YYMMDD`=6，`SEQ:n` 按 **n+1 位**估，预留一次进位）。[R9]
4. 样品实体额外 ≤ **32 字节**（二维码 token + 标签版面），且字面部分必须 ASCII（`print/sample-card.ts` 注释：中文会画成方框）。
5. 模板不得只由 `{SEQ:n}` 组成——至少含一个字面字符或一个日期占位符，否则无法分桶。

错误码沿用 `KernelError` + `reason`（与 `TemplateValidationIssue.code` 逐字一致）：`CODE_TEMPLATE_UNKNOWN_PLACEHOLDER` / `CODE_TEMPLATE_SEQ_REQUIRED` / `CODE_TEMPLATE_SEQ_MULTIPLE` / `CODE_TEMPLATE_TOO_LONG` / `CODE_TEMPLATE_NON_ASCII_LITERAL` / `CODE_TEMPLATE_NO_LITERAL`。非 ASCII 字面量对**所有实体**拒绝，不只是样品。

### 5.3 运行时硬校验与进位超限 `[R9]`

评审指出「n+1 位是容量预算，不是真正的最坏宽度」。因此分两层：

- **保存期（静态预算）**：按 §5.2 第 3/4 条估算，拦截「模板本身就装不下」的配置。
- **运行时（硬校验）**：每次生成后按**实际渲染结果**重新计算字节数（中文按 3 字节）；若超过实体上限（通用 64 / 样品 32），抛 `CODE_OVERFLOW` 业务错误并**不写库**，提示管理员调小其它占位符或改用更短模板。
- **进位行为**：`SEQ` 实际值位数 > n 时**自然进位**（`{SEQ:2}` 第 100 条渲染为 `100`，不截断、不报错），只有当进位后的完整编号触碰字节上限才由运行时硬校验拦截。这样「最坏情况」有明确定义与兜底，不是靠估算放行。

### 5.4 设计取舍：不开放可变业务字段占位符

编号是寻址标识，写进二维码、打印在样卡上、被单据引用。若编号来自 `name` / `category` / `color` 这类可编辑字段，一次改名就让编号和实物脱钩。第一版只开放**确定性占位符**（实体字头 + 北京时间 + 流水）。后续若确有诉求，走「不可变短码」（生成时冻结一个 `code_token` 存库），而不是在模板里直接引用可变字段。

---

## 6. 内置预设（系统推荐）

`packages/schema/src/code-rule.ts` 定义纯数据常量，前后端共用（与 `PRINT_VARIABLES` 同一模式）：

| preset key | 名称 | customer | sample | quote | order | sample_shipment |
|---|---|---|---|---|---|---|
| `classic` | 沿用现状（默认） | `C{YYMMDD}-{SEQ:4}` | `S{YYMMDD}-{SEQ:4}` | `BJ{YYMMDD}-{SEQ:4}` | `DD{YYMMDD}-{SEQ:4}` | `JY{YYMMDD}-{SEQ:4}` |
| `compact` | 紧凑无分隔符 | `C{YYMMDD}{SEQ:4}` | `S{YYMMDD}{SEQ:4}` | `BJ{YYMMDD}{SEQ:4}` | `DD{YYMMDD}{SEQ:4}` | `JY{YYMMDD}{SEQ:4}` |
| `yearly` | 年月分组 | `C{YYYYMM}-{SEQ:4}` | `S{YYYYMM}-{SEQ:4}` | `BJ{YYYYMM}-{SEQ:4}` | `DD{YYYYMM}-{SEQ:4}` | `JY{YYYYMM}-{SEQ:4}` |
| `plain` | 纯字头流水 | `{PREFIX}{SEQ:5}` | `{PREFIX}{SEQ:5}` | `{PREFIX}{SEQ:5}` | `{PREFIX}{SEQ:5}` | `{PREFIX}{SEQ:5}` |

**默认行为**：未配置规则 = `classic`。客户 / 样品逐字节等同现状；报价新编号从 `BJ-YYYYMMDD-A3F9`（UUID 前缀）变为 `BJ261122-0001`（流水），**历史报价展示不变、新报价形态变化**（§0 [R8]）。UI 报价卡片固定说明这一点。

---

## 7. 生成契约与并发闭环 `[R1][R6][R7]`

新增 `apps/api/src/kernel/code-number.service.ts`。

### 7.1 核心算法：同事务原子计数器

```
allocate(entityType, tenantId, now) 在调用方的事务 tx 内执行：

1. 取启用规则（无 → classic）；渲染 bucket = 模板去掉 {SEQ:n} 后的字面部分
2. 原子取号（一条 SQL，同事务）：
   INSERT INTO code_counters (tenant_id, entity_type, bucket, seq)
   VALUES ($tenant, $entity, $bucket, 1)
   ON CONFLICT (tenant_id, entity_type, bucket)
   DO UPDATE SET seq = code_counters.seq + 1, updated_at = now()
   RETURNING seq
   → 数据库保证同桶并发递增串行，两个事务拿到不同 seq
3. 渲染 code = 模板替换占位符（日期用固定 +8h；SEQ 左补零到 n 位）
4. 运行时宽度硬校验（§5.3），超限抛 CODE_OVERFLOW
5. 返回 code 给调用方，业务写入与计数器同事务提交
```

**为什么并发安全**：`ON CONFLICT ... DO UPDATE ... RETURNING` 在 PostgreSQL 中对同一主键行是原子的——并发事务会在该行上串行更新，各自拿到不同的 `seq`。计数器写入与业务写入共用调用方事务，因此业务回滚时取号也回滚，无号段空洞（撞码重算除外）。

### 7.2 撞码处理：只认编号唯一索引 `[R7]`

显式 code（客户/样品/订单）可能占用计数器即将分配的号，造成唯一冲突。处理算法：

1. 调用方捕获写入异常，用 `uniqueViolationConstraint(error)`（`errors.ts:86`）取约束名；
2. **只有**命中本实体的编号唯一索引才重算：
   - `customers_tenant_code_idx` / `samples_tenant_code_idx` / `orders_tenant_code_idx` / `quotes_tenant_code_idx` / `sample_shipments_tenant_code_idx`
3. 重算 = **回滚整个事务后重新走 §7.1**（新事务会拿到 +1 后的 seq），最多 3 次；仍冲突抛 `KERNEL_REJECTED` + 对应 `*_CODE_EXISTS`；
4. **其他唯一约束一律不重算，原样冒泡**：
   - `customers_tenant_draft_source_idx` / `samples_tenant_draft_source_idx` 是**草稿幂等键**，不是撞码——现有 `samples.service.ts:471` 的做法是先 `findByDraftSource` 命中则返回既有草稿，`created=false`，这个语义保留；
   - 如 `sample_images_primary_per_sample_idx` 等与本功能无关，必须原样抛出，绝不吞掉当撞码处理。

> 与 v0.1 的区别：删除「事务外取号 + 盲重试 3 次」和 Q3 的「探测 100 次」。现在每次重试都是完整事务 + 原子递增，不存在「重试仍拿同一号」的死循环，也不需要 100 次探测。

### 7.3 性能与数据规模 `[R6]`

**假设**：单租户客户/样品 ≤ 10 万行，报价/订单/寄样 ≤ 100 万行；单租户单日单分桶新增 ≤ 1 万。

- **创建路径**：计数器按主键 `(tenant_id, entity_type, bucket)` 做 UPSERT（`ON CONFLICT DO UPDATE ... RETURNING`），O(1) 点查仲裁；**不再有 `SELECT MAX + LIKE` 扫描**。这是本次改造的核心性能收益。
- **迁移回填**（仅一次）：按存量最大号初始化 `code_counters`。实际落地的 `0038` 迁移使用按 `(tenant_id, code)` 前缀分组的一次性聚合，**执行计划是全表 Seq Scan，不是索引范围扫描**；这是可接受的离线维护窗口操作，不属于热路径。v0.2 文档中「回填必须走索引、不得 Seq Scan」的要求按实际情况订正，不再作为验收项。
- **预览接口**（§10.1）：只渲染，不写计数器，O(1)。

#### 7.3.1 实测基准（2026-11-22，本地 PG 5433，owner 直连）

在 `code_counters` 造 **10 万行**历史分桶（独立租户 `11111111-…`），执行与生产同形的取号 SQL；基准数据测完立即删除（清理后 `count(*) = 0`，不留脏数据）。

| 项目 | 结果 |
|---|---|
| 取号 UPSERT `EXPLAIN ANALYZE` | `Insert on code_counters` → `Conflict Resolution: UPDATE`，**`Conflict Arbiter Indexes: code_counters_tenant_id_entity_type_bucket_pk`**，`Buffers: shared hit=14`，`Execution Time: 0.076 ms`，**无 Seq Scan** |
| 10 万行存量下连续取号 100 次 | **1.27 ms**（≈ 0.013 ms/笔），同桶 `seq` 精确递增到 100 |
| 近空表对照连续取号 100 次 | **0.64 ms**（≈ 0.006 ms/笔） |
| M6 回填查询 `EXPLAIN ANALYZE` | `HashAggregate` + **`Seq Scan on customers`**，`Execution Time: 0.499 ms`（1246 行样本、过滤出 56 行 classic 编号） |

结论：10 万行存量与近空表的取号耗时处于同一量级，差异来自缓存预热而非数据量，验证「取号只按主键点查、与历史编号规模无关」；回填的 Seq Scan 只发生在一次性迁移窗口，实测 < 1 ms，确认不构成热路径风险。正确性另由同桶 20 并发测试（计数器精确 +20）覆盖。

---

## 8. 五类实体接入方案

| 实体 | 规则生效路径 | 需要改什么 |
|---|---|---|
| 客户 | `createForHuman`（无 code）、`createDraft` | 两处生成为 `allocateCode`；删本地函数；`create` 的显式 code 保留 |
| 样品 | `createDraft` 自动生成；`create` 显式 code 保留 | `createDraft` 换 `allocateCode`；删本地函数；`create` 不动 |
| 报价 | 新建时生成 | `quotes` 加 nullable `code` + 唯一索引；create 写 code；`quoteNumberOf` 优先 code、空回退派生 |
| 订单 | `createForHuman` / create 未传 code 时 | `CreateOrderInput.code` 改 optional；服务端生成；补唯一索引；显式 code 保留 |
| 寄样单 | 创建时生成 | `sample_shipments` 加 nullable `code` + 唯一索引；insert 写 code；读模型带上 |

### 8.1 改码入口与铁律的关系 `[R2]`

评审指出 v0.1 的「编号一旦写出不可变」与现状冲突：`UpdateSampleInput.code`（`kernel.ts:122`）可选，`samples.service.ts:578` 会实际更新。本文档**不改这个业务行为**，只把铁律收敛为「**规则变更不追溯历史编号**」——两者不矛盾：

- **规则层**：改模板 / 换预设 → 只影响新建，历史编号一个字节不动。
- **记录层**：显式改 `code` 是**纠错操作**，保留原能力；但要求：① 走独立 update 入口（现状已满足）；② `SAMPLE_UPDATED` 审计已含 before/after code（`samples.service.ts:643`）；③ UI 改码时二次确认，提示「已打印样卡的二维码会失效，需重打」——因为二维码 token 内嵌 code（`share-token.ts`），改码后旧码指向的编号与库中不符。
- **回归测试**：改规则前后历史编号不变；显式改码仍可用且审计完整；改码后旧二维码按现有逻辑失效（`public-sample-card.service.ts` 的「编号已改」分支）。

### 8.2 报价读取收口（兼容关键）

`quoteNumberOf(row)` 签名从 `{ id, createdAt }` 扩成 `{ id, createdAt, code? }`：

```
row.code 有值 → 返回 row.code（新报价用规则编号）
row.code 为空 → 返回旧派生值 BJ-${YYYYMMDD}-${id前4大写}（历史报价外观不变）
```

调用点同步补 `code` 字段：`quotes.service.ts:556 / 658 / 871`（完整 row 直带）；`:762`（聚合行 `{ quoteId, quoteCreatedAt }`，select 补 quote.code）；`print/sample-card.service.ts:198`（传入 quote 行补 code）。这样打印样卡、复制文本、客户分享页的报价编号**统一跟随新规则，且历史单据不变**。

### 8.3 样品 32 字节双重防线

1. 保存规则时静态容量预算（§5.2 第 4 条）；
2. 生成时运行时硬校验（§5.3）；
3. 打印/分享链路保留现有 `assertSampleCodeFits`（`print/sample-card.ts:66`）与 share-token 32 字节检查，防历史数据或手工 code 绕过。

### 8.4 唯一性

新增索引：`quotes_tenant_code_idx`、`orders_tenant_code_idx`、`sample_shipments_tenant_code_idx`。客户/样品已有索引不动。所有实体统一走 §7.2 的冲突识别。

---

## 9. 兼容与迁移 `[R4]`

### 9.1 迁移步骤（顺序固定）

| 步骤 | 动作 |
|---|---|
| M1 | **前置检查**（阻断式）：订单存量重号检查，见 §9.2。有重复则**迁移失败并停止**，走清理流程，不允许降级 |
| M2 | 建 `code_rules`、`code_counters` 两张表（含 §4.3 的 RLS DDL） |
| M3 | `quotes` / `sample_shipments`：**新增 nullable `code` varchar(64) + 唯一索引**；历史行为 NULL，不回填 |
| M4 | `orders`：**保留现有 `code` NOT NULL 列不动，只新增唯一索引** `orders_tenant_code_idx` |
| M5 | `rls.sql` 登记两张新表（GRANT 列表 + business_tables 数组），并跑 `rls-grants.test.ts` |
| M6 | 回填 `code_counters`：按 classic 规则前缀从存量最大号初始化（只回填有存量的桶）。实际是一次性 Seq Scan，必须在维护窗口执行（§7.3） |

**明确订正**：orders 的列已经存在且非空，不存在「三张表加 nullable code 列」的情况；只有 quotes / sample_shipments 是加列。

### 9.2 订单重号检查（阻断式）

```sql
SELECT tenant_id, code, count(*)
FROM orders
GROUP BY tenant_id, code      -- 必须按 (tenant_id, code) 分组
HAVING count(*) > 1;
```

- **必须按 `(tenant_id, code)`**：只按 `code` 会把不同租户间合法的同号误判为脏数据。
- **有重复即失败**：不提供「改用非唯一索引」备选——那直接违背 §14「订单无法重号」的验收标准。
- **清理流程**：输出重复的 `(tenant_id, code, order_ids, created_at)` 清单 → 人工确认保留哪一笔 → 给其余订单走显式改码入口换成新 code（改码审计留痕）→ 重新跑 M1 直到 0 行 → 继续 M2+。

### 9.3 行为兼容表

| 情况 | 行为 |
|---|---|
| 老租户未配置规则 | 回退 `classic`；客户/样品逐字节不变 |
| 历史客户/样品编号 | 不改；新规则只作用于新建 |
| 历史报价 | code 为 NULL，展示走派生兜底，外观不变 |
| 历史订单 | code 有值原样保留；M1 通过后加唯一索引 |
| 历史寄样单 | code 为 NULL，显示「—」，不回填 |
| 用户改了规则 | 新编号按新模板，序号按新 bucket 从 1 起；UI 预览提示 |
| 导入 / 智能体 / API 传了 code | 限客户/样品/订单，显式优先；报价/寄样单不接受 |

---

## 10. API 与 UI

### 10.1 API（apps/api 租户面）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/code-rules` | 列出五类实体当前规则（含缺省 `classic` 的虚拟项）与可用预设 |
| GET | `/api/code-rules/preview?entityType=&template=` | 3 个示例编号 + 宽度检查 + bucket 预览；**不落库、不占号** |
| PUT | `/api/code-rules/:entityType` | 保存 `{ template, presetKey?, enabled? }`；服务端校验 §5，返回校验错误码 |
| POST | `/api/code-rules/:entityType/reset` | 恢复 `classic` |

实现：`apps/api/src/http/code-rules.controllers.ts`（已注册到 `http.module.ts`）。前端入口在 `packages/core/src/api-client.ts`：
`codeRules` / `previewCodeRule` / `saveCodeRule` / `resetCodeRule`，并与 `mock-client.ts` 同形（演示模式只读）。

权限：`settings.edit`（OWNER/MANAGER，`capabilities.ts:49/93`），无需新增 capability；判定**只在内核 `CodeNumberService.save`**，HTTP 层不复制。每次写操作 `appendAudit`（before/after template，entityType=`code_rule`，action=`CODE_RULE_SAVED`）。

### 10.2 UI（apps/web 桌面设置页）

实际落点：`/settings?section=codes`，组件 `apps/web/app/(desktop)/settings/code-rules-section.tsx`，
导航项由 `SETTINGS_SECTIONS` 投影（label「业务编号」，需要 `settings.edit`）。

- 五个实体各一张卡片：当前模板、示例编号、状态（默认模板/已配置）、[保存规则] [恢复默认]。
- 预设下拉一键套用 `classic / compact / year / plain`；模板输入框 + 占位符提示 + 实时预览 + 校验错误就地显示。
- 非法或超宽模板禁用保存；无修改时禁用保存；只读角色显示权限提示。
- 报价卡片提示「历史报价编号外观不变，新报价才使用规则」；样品卡片提示「二维码会失效，改码需重打」；寄样卡片提示历史单不回填。

### 10.3 与 v0.2 的实现偏离（已确认取舍）

| 项 | v0.2 设计 | 实际实现 | 原因 |
|---|---|---|---|
| API 所在应用 | admin 控制面 | `apps/api` 租户业务面 | `apps/admin` 只连 platform-api，拿不到租户业务库；`apps/web` 有到 `apps/api` 的 BFF |
| UI 所在应用 | `apps/admin/app/(console)/settings/code-rules` | `apps/web/app/(desktop)/settings` 的 `?section=codes` | 同上；不放 admin 避免走不通的数据链路 |
| 预览方法 | POST `/api/code-rules/preview` | GET（query string） | 纯读、可缓存，前端 `useQuery` 直接按 key 缓存 |
| 回填执行计划 | 必须走索引、不得 Seq Scan | 一次性 Seq Scan（§7.3） | 单次迁移聚合，不是热路径；按实际实现订正 |

---

## 11. 测试计划

| 层级 | 用例要点 |
|---|---|
| 单元（schema） | 白名单解析；未知占位符拒绝；SEQ 必须且仅一次；n 边界 1/8；容量预算宽度（含样品 32 字节、中文字面量拒绝） |
| 单元（api） | 模板 → bucket/正则渲染；北京时区跨日（`2026-11-15T16:00Z` → `261116`）；序号进位（`9999→10000`）；运行时宽度超限抛 `CODE_OVERFLOW` |
| **并发（新增）[R1]** | 同一 `(tenant, entity, bucket)` 起 N（如 20）个并发创建请求：**全部成功**、code 互不相同、计数器 seq 恰好 +N；跨 bucket 并发互不阻塞 |
| 冲突识别 `[R7]` | 显式占号导致 `*_tenant_code_idx` 冲突时自动重算成功；命中 `*_tenant_draft_source_idx`（草稿幂等键）时走「返回既有草稿」而非重算；注入其他唯一约束冲突时原样冒泡、不被吞掉 |
| RLS `[R3]` | `code_rules` / `code_counters` 跨租户不可读、不可写、不可覆盖同实体规则；纳入 `rls-grants.test.ts` |
| 集成 | 五类实体：未传 code 自动生成；显式 code 仅在契约允许的实体生效；报价新单用 code / 老单回退派生；订单无法重号；寄样单有编号 |
| 迁移 `[R4]` | `(tenant_id, code)` 分组重号检查能放行跨租户合法同号、拦截同租户重号；有重复时迁移阻断并输出清单 |
| 回归 | `customer-code.test.ts`、`kernel.integration.test.ts`、`sample-card` 系列、e2e 打印链路全绿；改规则前后历史编号不变、显式改码仍可用且留审计（§8.1） |
| HTTP（新增） | `apps/api/test/code-rules.e2e.test.ts`：列表 / 预览 / 保存 / 审计 / 恢复默认 / 非法模板 / 权限拒绝 |

**落地文件**：`packages/schema/test/code-rule.test.ts`（16 用例）、`apps/api/test/code-number.integration.test.ts`（7 用例）、
`code-number-entities.integration.test.ts`（4 用例）、`code-number-documents.integration.test.ts`（5 用例）、
`code-rules-rls.integration.test.ts`（4 用例）、`code-rules.e2e.test.ts`（6 用例）。
编号相关真连 PG 用例在无本地 5433 实例时按项目惯例 skip；但仓库里的打印 / 越权 / 并发回归等套件
**明确禁止静默跳过**，缺库会直接失败。本次汇总环境未起 PG：`code-rules.e2e.test.ts` 6 用例 skipped，
`pnpm --filter @weave-order/api test` 的 18 个失败全部来自这类「必须有 PG」的既有套件，
与编号规则无关。离线可跑部分（schema/core/web/api 类型检查与纯单测）全绿。
另有一个与本次改动无关的失败：`packages/schema/test/field-options.test.ts` 的预置字段断言，
因并行工作新增 `sample.material` 未同步更新该断言（本轮未触碰该并行改动）。

---

## 12. 任务拆分与落地状态

| 任务 | 内容 | 状态 |
|---|---|---|
| T1 契约、表与 RLS | `schema` 加 `CodeRule` + 占位符解析/校验纯函数；`db` 加 `code_rules` + `code_counters` 两表与 RLS DDL；`rls.sql` 登记两处；`0038` 迁移（含 M1 阻断检查） | ✅ 完成 |
| T2 生成服务 | `CodeNumberService`（原子计数器 + 同事务 + SAVEPOINT + 冲突识别）+ 单测 + 20 并发用例 | ✅ 完成；10 万行基准见 §7.3.1 |
| T3 客户/样品接入 | 删重复逻辑，改调新服务；显式改码语义回归 | ✅ 完成；样品人工主路径保持显式料号（Q1 已结案） |
| T4 报价/订单/寄样接入 | 加列写入、`quoteNumberOf` 收口、订单 code 改 optional、寄样单写入与读模型 | ✅ 完成 |
| T5 API 与 UI | `code-rules` 四端点 + `apps/web` 设置页 + 实时预览 | ✅ 完成（落点调整见 §10.3） |
| T6 回归与文档 | 全量 typecheck / 测试 / 性能基准 / 文档收尾 | ✅ 完成 |

T1→T2→T3/T4 串行；T5 在 T2 出接口后并行完成；T6 收尾（起本地 PG 复跑真库套件 + 补 10 万行基准 + Q1/Q7/Q8 结案）。

---

## 13. 风险与开放问题

| # | 问题 | 影响 | 处置 |
|---|---|---|---|
| Q1 | 样品人类新建主路径实证为 `create` + 必填 code（`sample-editor.tsx` 有必填编号框，placeholder「如 FM-220」），不是 `createDraft` | 自定义规则在样品人工主路径未生效，只覆盖 `createDraft` / 直接 `allocate` | **已结案（保持现状，不改契约）**：样品人工编号是业务上的人工料号（FM-220 一类自定义编码），本身就是「用户自定义」最直接的形式；规则体系服务的是**系统自动生成**的编号（草稿 / OCR 导入路径）。强行接入需把 `CreateSampleInput.code` 改 optional、重构 `index.prepare` 向量文本时序（当前在事务前依赖 code，与「取号写入同事务」冲突）、并改变前端长期编号习惯；且 `samples.service.ts` 正被并行改动密集修改，收益不明确、冲突风险高。如后续要统一另立任务 |
| Q2 | 订单存量重号 | 加唯一索引会失败 | 已闭环：M1 按 `(tenant_id, code)` 阻断式检查 + 人工清理流程，无降级备选（§9.2） |
| Q3 | 改规则后序号从 1 起，撞显式 code | 生成失败 | 已闭环：原子计数器 + 编号唯一索引识别 + 同事务重算（§7），不再用 100 次探测 |
| Q4 | 报表/打印是否硬编码 `C`/`S`/`BJ` 前缀 | 改字头后展示错位 | T4 全局搜 `startsWith("C")`、`"BJ-"` 等；已定位 `quoteNumberOf`，其余落地时扫一遍 |
| Q5 | 改码后二维码失效 | 已发出样卡扫码失败 | 已定为显式纠错的已知代价：UI 二次确认 + 提示重打 + 审计；不改业务行为（§8.1） |
| Q6 | 计数器单行成为同桶热点 | 单桶万级/日时行锁竞争 | 已用桶拆分（按日期+格式）降低热点；若实测仍高，按实体分表或加随机后缀分桶 |
| Q7 | 未产出 10 万行存量基准与 `EXPLAIN` 数字 | 性能收益有结构论证，缺量化证据 | **已闭环**：§7.3.1 给出 10 万行存量下取号 `EXPLAIN`（主键仲裁、0.076 ms、无 Seq Scan）与 100 笔创建耗时（1.27 ms vs 空表 0.64 ms），并实测 M6 回填为一次性 Seq Scan；基准数据已清理 |
| Q8 | UI 落在 `apps/web` 而非原设计的 `apps/admin` | 与原设计文档不一致 | **已结案（按实施结果定稿）**：`apps/admin` 只连 `platform-api`，无租户业务库通路；`apps/web` 有到 `apps/api` 的 BFF，是唯一能打通的落点。§10.2 / §10.3 已同步实际位置，不再作为待确认项 |

---

## 14. 验收清单（实现状态）

- [x] 未配置规则时，客户/样品逐字节兼容、历史报价外观兼容；新报价形态变化已在 UI 卡片说明。
- [x] 管理员可为任一类实体套用预设或写自定义模板，实时预览正确，非法模板被拒且给出可读错误码。
- [x] 自定义模板生成的编号在五类实体均正确落库、唯一（集成测试覆盖；样品人类新建主路径限制见 Q1）。
- [x] 样品自定义模板超 32 字节 / 非 ASCII 无法保存；运行时进位超限抛 `CODE_OVERFLOW` 不写库。
- [x] **同分桶 20 并发取号全部成功、无重号、计数器精确 +20**（`code-number.integration.test.ts`）。
- [x] 只有编号唯一索引冲突才重算；草稿幂等键命中返回既有草稿；其他唯一约束原样冒泡（`code-conflict.ts` + 单测）。
- [x] `code_rules` / `code_counters` 已启用并强制 RLS，登记 `rls.sql` 两处；跨租户不可读/写/覆盖，纳入 grants 测试。
- [x] 订单无法重号（迁移前置检查按 `(tenant_id, code)`、有重复阻断）；寄样单有编号并可展示。
- [x] 历史数据零改动；改规则不追溯历史；显式改码仍可用、留审计、有二维码失效提示。
- [x] 写规则有审计（`CODE_RULE_SAVED`）；非 OWNER/MANAGER 被拒（内核层 + e2e 用例）。
- [x] 创建路径无 `MAX+LIKE` 扫描，改为计数器主键 UPSERT。
- [ ] 迁移回填 `EXPLAIN` 走索引 + 10 万行基准数字：**未按原计划达成**，回填实为一次性 Seq Scan（§7.3），压测数字待补（Q7）。
- [ ] 现有测试与 e2e 全绿：本次汇总环境未起 PG，编号相关 e2e skipped；仓库中「禁止静默跳过」的 PG 套件失败；另有一个并行改动引入的 field-options 断言失败。需起本地 PG 并同步该断言后复跑。
