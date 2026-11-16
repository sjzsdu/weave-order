# Track F · 平台总管理端（控制面 + apps/admin）

> 版本：v1.0 ｜ 对应 WAN-89 ｜ 依赖 Track A 的订阅/计量概念，独立于 Track G（打印）。

平台总管理端是**独立产品**：`apps/admin`（Next.js 15，默认 `:3003`）+ `apps/platform-api`（NestJS 控制面，默认 `:3002`）+ 独立数据库 `weave_platform`。它只连控制面数据，默认看不到任何租户业务数据。

## 1. 为什么是独立进程 + 独立库

| 层   | 租户端                                         | 平台端                                                       |
| ---- | ---------------------------------------------- | ------------------------------------------------------------ |
| Web  | `apps/web` / `apps/mobile` / `apps/quote`      | `apps/admin`                                                 |
| API  | `apps/api`（:3000，持有租户业务库连接）        | `apps/platform-api`（:3002，只持有 `PLATFORM_DATABASE_URL`） |
| DB   | `weave_order`（业务表 + RLS）                  | `weave_platform`（`control` schema）                         |
| 身份 | Casdoor `weave-order-web`，按租户 Organization | Casdoor `weave-platform`，强制 MFA、禁止社交登录             |
| 审计 | `audit_log`（租户）                            | `control.platform_audit`（只追加）                           |

`apps/platform-api` **没有**租户业务库连接字符串，因此「平台管理员误看报价明细 / 样品图 / 客户手机号」在代码层就不可达，不依赖界面隐藏。`apps/platform-api/test/isolation.test.ts` 会扫描源码，禁止 import 租户 schema 或业务表名。

## 2. 数据模型（`control` schema）

| 表                            | 用途                                                                     |
| ----------------------------- | ------------------------------------------------------------------------ |
| `platform_users`              | 平台人员名册（角色、MFA、状态）。Casdoor 令牌只用于认证，授权以本表为准  |
| `tenants`                     | 租户账号级信息：状态、隔离模式、区域、健康度、联系人、试用/转正/流失时间 |
| `plans`                       | 套餐定义（席位范围、agent 动作额度、存储、功能集合）                     |
| `price_books` / `plan_prices` | 版本化价格表：DRAFT → ACTIVE → RETIRED；新版本不影响存量合同             |
| `tenant_price_overrides`      | 租户合同价：生效日、到期日、原因、审批人                                 |
| `subscriptions`               | 每租户一条订阅：套餐、席位、账期、生效月费、下次扣费                     |
| `usage_events`                | 用量事件：`idempotency_key` 唯一，重放不计量                             |
| `usage_daily`                 | 日聚合：agent 动作 / 存储 / 短信 / LLM token / LLM 成本                  |
| `tax_profiles`                | 租户开票资料与税率（覆盖平台默认）                                       |
| `invoice_settings`            | 平台默认发票类型、税率、主体、时机、红冲规则（版本号）                   |
| `invoices` / `refunds`        | 账单与退款：价税分离、行项目、状态机、独立发票号序列                     |
| `platform_audit`              | 平台动作审计，数据库触发器拒绝 UPDATE/DELETE                             |
| `approvals`                   | 双人复核申请：动作、payload、必需角色、票、过期、执行结果                |
| `break_glass_requests`        | 租户同意 + 双人复核 + ≤60 分钟只读授权（不持有业务数据）                 |
| `feature_flags`               | 按租户 / 比例灰度                                                        |
| `platform_configs`            | 配置中心：全局 → 套餐 → 租户三层，版本化 + 回滚                          |
| `llm_settings`                | 全局参数 + 租户覆盖；只存 Key 引用                                       |
| `identity_settings`           | MFA / SSO / Casdoor 组织模板                                             |
| `support_tickets`             | 工单                                                                     |

所有金额是**整数分**，token 只核算成本、不计费。

## 3. 角色与权限矩阵

| 权限                                                |        owner        | finance | support | ops | readonly |
| --------------------------------------------------- | :-----------------: | :-----: | :-----: | :-: | :------: |
| 总览 / 租户 / 账单 / 用量 / 价格 / 支持 / 审计 只读 |          ✓          |    ✓    |    ✓    |  ✓  |    ✓     |
| 开通公司 / 改套餐席位 / 改状态                      |          ✓          |         |         |     |          |
| 创建账单 / 登记回款 / 开票资料                      |          ✓          |    ✓    |         |     |          |
| 发票开具 / 红冲 / 退款申请                          |          ✓          |    ✓    |         |     |          |
| 改价（提交生效申请）                                |          ✓          |    ✓    |         |     |          |
| 开票设置（税率变更走复核）                          |          ✓          |    ✓    |         |     |          |
| LLM / 功能开关 / 配置中心 / 身份                    |          ✓          |         |         |  ✓  |          |
| 开单 / break-glass 申请                             |          ✓          |         |    ✓    |     |          |
| 审批决策                                            |          ✓          |    ✓    |         |     |          |
| 注销租户                                            | ✓（需第二位 owner） |         |         |     |          |

权限矩阵在 `apps/platform-api/src/domain/permissions.ts` 是唯一判定点；前端只读取 `/auth/me` 的 `permissions` 做展示。

## 4. 双人复核

危险动作永远不会单点直接执行：

| 动作                | 必需角色        | 说明                                                 |
| ------------------- | --------------- | ---------------------------------------------------- |
| `TENANT_PURGE`      | owner           | 第二个 owner 批准；只匿名化控制面账号，保留账单/审计 |
| `TENANT_FORCE_PLAN` | owner           | 强制合同价，先落 `tenant_price_overrides`            |
| `PRICE_CHANGE`      | owner + finance | 价格表从 DRAFT 生效；先做影响试算                    |
| `TAX_CHANGE`        | owner + finance | 任一税率变更                                         |
| `INVOICE_VOID`      | finance         | 红冲                                                 |
| `REFUND`            | owner + finance | 退款（资金出账），不得超过可退余额                   |
| `BREAK_GLASS`       | owner           | 必须已有租户同意记录                                 |

规则（`ApprovalsService`）：

1. 发起人不能批准自己的申请；
2. 必须覆盖全部必需角色；
3. 至少两名不同的人投票；
4. 60 分钟未完成自动过期；
5. 执行结果写回审批记录，并写 `platform_audit`（`APPROVAL_EXECUTED`）。

## 5. Break-glass

1. 客服填工单号 + 原因，并勾选「租户管理员已同意」；未同意直接 400。
2. 创建申请 + `BREAK_GLASS` 双人复核。
3. 批准后授权状态 `ACTIVE`，`expiresAt = now + min(配置, 60 分钟)`。
4. `POST /break-glass/:id/access` 只校验授权并写 `BREAK_GLASS_ACCESS` 审计；**不返回任何业务数据**。
5. 到期自动 `EXPIRED`。

产品 §14.6 的「临时只读令牌」由租户侧执行：控制面只发凭证，真正读业务库发生在租户应用内，并写租户审计「平台支持访问」。控制面进程没有业务库连接，这是结构性保证。

## 6. 计费口径

- 席位费：`effectiveMonthlyCents × seats`；年付按合同年价出账，MRR 按年价 / 12 折算。
- agent 动作：含套餐额度，超出按 ¥0.05 / 次（`DEFAULT_ACTION_OVERAGE_CENTS`）。
- 存储/短信/LLM：只计量；存储超额与短信进入用量看板，LLM token 只核算成本。
- 税额：`round(subtotal × taxRateBp / 10000)`，总额 = 小计 + 税。
- 账期：升级即时生效，降级立即生效（MVP 简化，下一张账单体现日折算）；发票号使用独立序列 `control.invoice_number_seq`。

纯函数在 `apps/platform-api/src/domain/billing.ts`，有单元测试覆盖。

## 7. API 一览

所有路由前缀 `/platform/api`。

```
GET  /health
GET  /auth/me
GET  /overview
GET  /usage/overview
POST /usage/events                     # 平台令牌 usage:write 或 x-ingest-key
GET/POST /tenants
GET  /tenants/:id
PATCH /tenants/:id/subscription        # 带 forceMonthlyPriceCents 时返回 approval
POST /tenants/:id/status
POST /tenants/:id/purge-request
GET  /tenants/:id/usage
GET/PUT /tenants/:id/tax-profile
GET  /tenants/:id/overrides
GET/POST /invoices
GET  /invoices/:id
POST /invoices/:id/issue
POST /invoices/:id/paid
GET  /invoices/:id/refunds
POST /invoices/:id/refund-request
POST /invoices/:id/void-request
GET/PATCH /settings/invoicing          # 税率变更返回 approval
GET  /pricing/plans | /pricing/books | /pricing/books/:id
GET  /pricing/books/:id/impact
POST /pricing/books
POST /pricing/books/:id/activate-request
GET  /pricing/overrides
POST /pricing/preview
GET  /approvals | /approvals/:id
POST /approvals/:id/decide
GET  /audit
GET/POST /break-glass
GET  /break-glass/:id
POST /break-glass/:id/access
POST /break-glass/:id/reject
GET/PUT /settings/llm
POST /settings/llm/test
GET  /settings/llm/stats
GET/POST /settings/feature-flags
PATCH /settings/feature-flags/:key
GET  /settings/configs | /settings/configs/history
POST /settings/configs/preview | /settings/configs
POST /settings/configs/:id/rollback
GET/PATCH /settings/identity
GET/POST /support/tickets
PATCH /support/tickets/:id/status
```

## 8. 本地运行

```bash
pnpm install
docker compose up -d postgres          # 端口 5433
pnpm platform:migrate                  # 自动建 weave_platform + control schema
pnpm platform:seed                     # 平台人员 / 套餐 / 价格表 / 演示租户

pnpm --filter @weave-order/platform-api dev   # :3002
pnpm --filter @weave-order/admin dev          # :3003
```

打开 `http://localhost:3003`：本地会显示 6 个开发身份（owner / owner2 / finance / ops / support / readonly），点选即用；owner2 用于危险操作的第二人复核。生产构建不显示、也不回退 dev 令牌。

生产环境变量见 `.env` 的「E4 平台总管理端」段：`PLATFORM_AUTH_MODE=oidc`、`CASDOOR_PLATFORM_*`、`PLATFORM_REQUIRE_MFA=true`、`PLATFORM_INGEST_KEY`。

## 9. 验收路径（一个人做一次具体动作）

1. 以 `dev:owner` 打开 `/tenants`，展开「开通公司」：填青禾纺织 / `qinghe-demo` / Pro / 10 席 / 14 天试用 → 提交。
2. 进入租户详情，改套餐为 Pro、席位 20，保存；再填强制定价 ¥449 → 提交，页面提示「已提交复核」。
3. 打开 `/approvals`，以 `dev:owner` 无法自批；强制合同价需第二位 owner，切到 `dev:owner2` 批准 → 订阅与合同价生效。（价格表生效需 owner + finance：发起人是 owner 时切 `dev:finance` 批准。）
4. `/usage` 查看该租户 agent 动作 / 存储 / LLM 成本；`/tenants/:id` 查看 14 天趋势。
5. `/billing` 展开「开一张账单」：选租户、当月账期 → 生成草稿 → 开具 → 登记回款。
6. 租户详情点「暂停（只读）」，再「恢复为正式」；`/audit` 能看到每一步平台审计。
7. 全程 `/tenants/:id` 只出现套餐、席位、用量、健康度、账单；没有报价明细、样品图或客户手机号。
8. 支持页申请 break-glass 时若不勾选租户同意会被拒绝；勾选后仍需第二位 owner 复核，激活后只能记录访问，拿不到业务数据。

自动化覆盖：`apps/platform-api/test/control-plane.integration.test.ts` 走通开通 → 改套餐 → 用量幂等 → 开票 → 双人复核 → 暂停/恢复 → 审计只追加；`isolation.test.ts` 扫源码保证控制面不引用业务表；`billing.test.ts` 覆盖金额与超额计算。

## 10. 已知边界 / 后续

**评审已收口（WAN-89 Review）**

- `PLATFORM_DATABASE_URL` 已加生产门控：`NODE_ENV=production` 时必须显式配置，且拒绝本地默认值；`resolvePlatformDatabaseUrl` 同样 fail-fast，避免迁移脚本在生产回落 dev 库。单测：`apps/platform-api/test/env.test.ts`。
- **Break-glass 代登录仍是后续项**：当前实现是「租户同意 + 双人复核 + ≤60 分钟授权簿记 + 审计」，`recordAccess` 不返回业务数据。§14.6 的完整链路（临时只读令牌 → 租户侧读取 → 每次查看审计 → 租户端顶部提示「平台支持正在协助」）需要租户 API 配合实现 impersonation，属于 P1 后续，不在 Track F 的 DoD 内。控制面不持有业务库连接是刻意设计，不能被绕过。

- 席位降级按产品应为「下个账期生效」，当前 MVP 立即生效并在下一张账单体现差额；日折算算法待账务规则确认。
- 价格表 grandfathering 通过订阅保存 `priceBookId` 实现，但账单当前按订阅生效月费计算，不会自动追溯改价（这是有意的）。
- 控制面不执行租户业务库物理删除，只做账号注销 + 数据导出工单；物理删除属于运维 runbook（独立库/实例场景）。
- Casdoor Organization 创建目前是展示与模板映射，真正调用 Casdoor Management API 的自动化待接入（需要 client credentials）。
- `platform_audit` 的只追加由数据库触发器保证；生产还应给 `weave_platform` 配置最小权限角色与独立备份。
- 生产部署必须设置 `PLATFORM_DATABASE_URL`（独立库）与 `PLATFORM_AUTH_MODE=oidc`；任一缺失或沿用 dev 默认值会直接启动失败。
- Break-glass 代登录（impersonation）待与租户端 API 联合实现，见上方「评审已收口」。
