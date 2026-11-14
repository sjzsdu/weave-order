# T0 地基 · 契约冻结与工程骨架

> 版本：v1.0 ｜ 日期：2026-11-12 ｜ 对应 issue：WAN-80
> 依据：`docs/architecture-and-tech-stack.md`（v1.3）、`docs/development-guide.md`、`docs/development-plan.md`

本文是 Track A~G 并行开工的**契约说明**。契约代码是唯一事实来源：

- Zod：`packages/schema/src/*`
- 物理表 + RLS：`packages/db/src/schema/*`、`packages/db/sql/rls.sql`
- 内核 / 工具 / 网关：`apps/api/src/{kernel,tools,gateway}`

## 1. 已完成范围

| 子项           | 交付                                                                               | 位置                                        |
| -------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| Monorepo 骨架  | `apps/mobile`（Taro：H5/小程序/RN 一套代码）、`packages/core`、`packages/ui`       | 各包 `package.json` + `turbo build`         |
| 契约           | 客户/样品/报价/订单/发货/应收；改稿；报价分享；租户/成员；工具 I/O                 | `packages/schema`                           |
| 数据层         | 全部业务表 `tenant_id`、`ENABLE + FORCE RLS`、应用角色无 `BYPASSRLS`、§10 关键索引 | `packages/db`                               |
| 内核/工具/网关 | 唯一写入口 + 同事务审计；工具只调内核；Casdoor OIDC 校验 + membership + 租户会话   | `apps/api/src`                              |
| 验收           | `pnpm build`、迁移、docker compose、最小内核链路、跨租户 RLS 用例                  | `apps/api/test/tenancy.integration.test.ts` |

## 2. 多租户模型（G4）

```
Casdoor ID Token ──(sub, org)──▶ memberships ──▶ tenant_id（本地为准）
                                             │
                          openTenantSession(pool, tenant_id)
                                             │  SET app.tenant_id
                                             ▼
                      内核 / Drizzle 查询（RLS 自动过滤 tenant_id）
```

- 前端**永远不传** `tenant_id`；HTTP 只认 `Authorization: Bearer <token>`。
- 一个认证请求 = 一条独占连接 + 一个绑定 `tenantId` 的内核；请求结束必须 `release()`。
- 应用角色 `weave_app`：`NOSUPERUSER`、`NOBYPASSRLS`；迁移后自动创建（开发口令 `weave_app`，**生产必须轮换**）。
- RLS 策略统一为：
  `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`
  `tenants` 表用 `id = ...`。未设置租户时比较为 NULL，读 0 行、写被 `WITH CHECK` 拒绝。
- `audit_log` 由数据库触发器保证只追加；内核在业务写事务内追加审计（写失败整单回滚）。

迁移命令会先跑 Drizzle SQL，再幂等套用 `packages/db/sql/rls.sql`：

```bash
pnpm db:migrate
```

## 3. 鉴权网关

| 环境      | `AUTH_MODE` | 行为                                                                        |
| --------- | ----------- | --------------------------------------------------------------------------- |
| 本地 / CI | `dev`       | 接受 `Authorization: Bearer dev:<sub>:<org>`                                |
| 生产      | `oidc`      | RS256 + JWKS 验签，校验 issuer/audience/exp，`org`/`orgName` 作为组织 claim |

生产环境若仍为 `dev`，进程拒绝启动（`main.ts` 与网关工厂双重拦截）。

**业务连接必须显式配置且不能绕过 RLS**：

- `NODE_ENV=production` 或 `AUTH_MODE=oidc` 时，`APP_DATABASE_URL` **必填**，缺省拒绝启动。
- 显式配置后，启动时查询 `pg_roles` 断言当前角色 `rolsuper=false && rolbypassrls=false`；
  否则 fail-fast（防止误用 owner 连接静默绕过 RLS）。
- 本地 dev 未配置时回退 `DATABASE_URL`，但会打印告警，且只允许 dev/test。

端点：

- `GET /api/auth/me` → `AuthContextResponse`（subject、租户、成员、角色、数据范围、审批上限）。
- `GET /api/auth/customers` → 示例：走租户会话 + RLS 的只读列表。

`(sub, org)` → membership 由平台连接查询；业务请求永远不跨租户。`org` 只用于校验，租户以本地记录为准。

**人类写路由的身份统一来自网关登录态**：

- 审批 / 改稿 / 导入等 HUMAN 写路由一律经 `HumanActorService`，角色取自 `memberships.role`，
  不再存在硬编码 `OWNER` 的静态上下文。
- 生产态缺 Bearer 令牌直接 401；缺少审批角色时 `assertCanApprove` fail-closed。
  仅 dev/test 在无令牌时回退 `DEV_HUMAN_CONTEXT`，只服务本地 demo 与既有集成测试。
- 生产态判定只有一个入口：`platform/runtime-mode.ts#isProductionLike`
  （`NODE_ENV=production` 或 `AUTH_MODE=oidc`），数据库守卫、分享密钥、审批角色共用同一条件。

> 硬约束：`DatabaseProvider`（平台/控制面连接）拥有跨租户可见性，**永远不能用于业务数据请求**。
> 业务请求只能经 `AppDatabaseProvider.openScope` 打开租户会话。`GatewayModule` 中
> `DIRECTORY_KERNEL` 与 `AppDatabaseProvider` 是两个独立 provider，不要合并。

## 4. 契约清单（冻结）

### 4.1 实体

| 域        | Zod                                                 | 表                                                       |
| --------- | --------------------------------------------------- | -------------------------------------------------------- |
| 租户/成员 | `Tenant` `Membership` `AuthClaims` `RequestContext` | `tenants` `memberships`                                  |
| 客户      | `Customer` `CustomerContext`                        | `customers` `customer_contexts`                          |
| 样品      | `FabricSample`                                      | `samples` `sample_embeddings`                            |
| 寄样      | `SampleShipment`                                    | `sample_shipments` `sample_shipment_items`               |
| 报价      | `QuoteDraft` `QuoteLineItem`                        | `quotes` `quote_items`                                   |
| 订单      | `Order` `OrderLineItem`                             | `orders` `order_items`                                   |
| 发货      | `Shipment` `ShipmentLineItem`                       | `shipments` `shipment_items`                             |
| 应收      | `Receivable`                                        | `receivables`                                            |
| 改稿      | `RevisionRequest` `DraftRevision` `RevisionReason`  | `revision_requests` `draft_revisions` `revision_reasons` |
| 分享      | `QuoteShare` `QuoteShareEvent` `CustomerQuoteView`  | `quote_shares` `quote_share_events`                      |

### 4.2 全局约定

- 金额：`Money = { amount: 整数分, currency }`；**禁止浮点**，金额只能由内核计算。
- 数量：`{ value: number, unit }`；落库为 `quantity_milli`（千分之一单位）。
- 标识：UUID；时间：ISO 8601 UTC。
- 所有输入 `strict()`：未知字段（包括试图夹带 `tenantId`）直接拒绝。
- 工具失败统一 `ToolResult<T> = { ok:true,data } | { ok:false,error:ToolError }`；
  HTTP 面上这条 body 不变，状态码由 `statusForToolFailure` 按 `code` / `reason` 映射
  （400 / 403 / 404 / 409 / 422 / 502），端侧 transport 把这类 4xx body 还原成返回值。
- 审计动作是封闭集合（`AuditAction`），新增动作必须同时改契约。
- 分享只存 `token_hash`；客户视图 `CustomerQuoteView` 刻意不含成本/毛利/内部备注。
- 改稿必须携带 `before/after/patch/provenance`，AI 产出永远是 `DRAFT`/`PENDING`。

## 5. 给各 Track 的开工约定

| Track        | 可依赖                                                                      | 仍待落地（本 Track 负责）          |
| ------------ | --------------------------------------------------------------------------- | ---------------------------------- |
| A 内核与审批 | 全部实体契约、订单/应收/改稿表、内核租户绑定、审计                          | 订单/应收/改稿的内核方法与审批链路 |
| B 智能体     | 工具 I/O 契约、`ToolResult`、LiteLLM 地址/密钥约定、租户绑定内核            | 新工具实现、token 计量落库         |
| C 桌面 Web   | `packages/core` API client/hooks、`packages/ui` tokens/组件、`/api/auth/me` | Next.js 端页面与设计系统扩展       |
| D 移动       | `apps/mobile` Taro 五 Tab 骨架、离线队列、core hooks                        | 业务页面与相机直传                 |
| E 客户报价页 | `quote_shares` 契约与表、`CustomerQuoteView`                                | 分享 API、token 校验与 SSR 页面    |
| F 平台管理端 | `tenants`/`memberships` 契约                                                | 控制面角色、订阅/开票              |
| G 打印       | `audit_log`、租户会话                                                       | 打印表与 WSS 代理                  |

**mock 口径**：前端按 `packages/schema` 造响应，用 `createApiClient` 的 `fetchImpl` 注入；
后端真实现就绪后只替换 transport，不改页面逻辑。

## 6. 本地验收

```bash
docker compose up -d                 # PostgreSQL(pgvector) + Redis + LiteLLM
pnpm install
pnpm build                           # schema → db → api → web → mobile
pnpm db:migrate                      # 迁移 + 角色 + RLS
pnpm test                            # 含跨租户 RLS 常驻用例
APP_DATABASE_URL=postgres://weave_app:weave_app@localhost:5433/weave_order pnpm test
```

最小内核链路（测试已覆盖）：建租户 → 建成员 → 建客户 → 建样品 → 出报价草稿，
并断言 `audit_log` 同事务落库；租户 B 查询租户 A 的客户返回 `CUSTOMER_NOT_FOUND`。

## 7. 已知边界（不阻塞 Track）

- 订单/应收/改稿/分享目前**只有契约与表**，写方法由 Track A/E 实现；不要在前端直接写表。
- `apps/web` 仍是既有 Vite 实现，Next.js 迁移属于 Track C，T0 未重写。
- membership 目录查询使用平台连接（owner/控制面角色）；生产应换成控制面专用角色或
  `SECURITY DEFINER` 函数，业务连接始终是 `weave_app`。
- 开发口令 `weave_app` 只用于本地/CI；生产必须在部署时轮换为密钥管理注入。
- **负金额语义（billing/退款落地前必须定）**：当前 `Money.amount` 是
  `.int().nonnegative()`，展示层已能格式化负号。退款/折让落地时需决定：
  独立 `refundAmount` 字段，还是放开 `nonnegative` + 方向字段；不要直接放开约束。
- **多公司顾问（WAN-81 已落地）**：一个 sub 有多条 ACTIVE membership 时不再拒绝登录，
  而是走「登录后选择租户」：`/api/auth/me` 返回 `MULTI_TENANT` 列表，`POST /api/auth/switch`
  选择后由网关把 `tenantId` 绑定进 Redis 会话（`weave_sid` httpOnly Cookie）。
  决策与流程见 `docs/multi-tenant-selection.md`；`resolveMembership` 现在是
  `(subject, tenantId)`，`org` 只在单租户自动绑定路径做纵深校验。
