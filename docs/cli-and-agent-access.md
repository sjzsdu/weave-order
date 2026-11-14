# 用户凭据、CLI 与 agent 接入（WAN-78）

> 目标：让每个用户拥有自己的凭据，并能从织序之外的 agent（codex 等）安全地操作织序。
> 一句话：**人类用 Casdoor 登录一次，agent 拿着「只能干活、不能审批」的 token 调用工具，草稿回到审批窗口由人确认。**

## 1. 在既有认证之上补了什么

WAN-88 已经把租户认证交给 Casdoor OIDC：浏览器拿 httpOnly 会话，BFF 注入
`Authorization`，网关验签后解析 `(sub, org) → membership → tenant`，业务请求在
RLS 会话里执行。

OIDC token 有两个特点不适合 agent：15 分钟寿命、只存在于浏览器 Cookie。
WAN-78 因此增加**个人访问凭据（PAT）**，它复用同一条认证链路：

| 凭据         | 谁用               | 生命周期                | 权限                |
| ------------ | ------------------ | ----------------------- | ------------------- |
| OIDC 会话    | 人（浏览器）       | 8 小时，httpOnly Cookie | 角色 + RLS          |
| PAT `wo_...` | CLI / codex / 脚本 | 可设 1–365 天，随时撤销 | 角色 + RLS + 作用域 |

**关键设计：PAT 绑定 `membership.id`，不是另建一套用户。**
认证后仍然是同一个 tenant、同一个 role、同一条 RLS 会话，不会因为「走 CLI」
而绕过租户隔离或角色约束。

## 2. 作用域

| 作用域    | 允许                                                       | 默认            |
| --------- | ---------------------------------------------------------- | --------------- |
| `read`    | 审批队列 / 详情 / 全景等只读聚合                           | ✅              |
| `write`   | 调用工具（找样、客户 360、报价草稿、寄样草稿）、改稿、导入 | ✅              |
| `approve` | `POST /api/approvals/decide`                               | ❌ 必须显式授予 |

默认登录只发 `read,write`。即使 agent 完全掌握了这枚 token，也无法把草稿变成
生效单据——它最多把草稿堆满审批窗口，而这是**可见且可撤销**的。

低权凭据也不能给自己扩权：用 `read,write` 的 PAT 调 `POST /api/auth/tokens`
申请 `approve` 会被 `SCOPE_REQUIRED` 拒绝；只有 OIDC 人类会话或已持 `approve`
的凭据可以签发 `approve`。

## 3. CLI 登录：设备码 + 浏览器会话

```
CLI                                API                         浏览器（已登录）
 │  POST /api/auth/device/start     │                              │
 │◀── deviceCode + userCode ────────│                              │
 │                                  │  GET /cli-login?user_code=…  │
 │                                  │◀──── 打开确认页（BFF Cookie） │
 │                                  │  POST /api/auth/device/decide│
 │                                  │  （服务端注入 OIDC 令牌）      │
 │  POST /api/auth/device/poll      │                              │
 │◀── approved + 明文 token ────────│（一次性消费，重放被拒）       │
 │  保存 ~/.config/weave-order/config.json (0600)                   │
```

- `deviceCode` 40 位随机串，只存哈希；`userCode` 8 位易读字符，10 分钟有效、只能用一次。
- 确认页在 `apps/web/app/cli-login/route.ts`：浏览器只带 httpOnly Cookie，
  **由服务端**把 `Authorization` 注入后调用 API；令牌不进浏览器脚本。
- 未登录访问确认页会跳 `/auth/login?next=/cli-login?user_code=…`。
- 批准时记录的是当前会话的 membership，不需要也不允许表单自报邮箱。
- `weave login --token <token>` 支持直接导入已有凭据（CI、远程 agent 环境）。

## 4. HTTP 面

| 方法   | 路径                      | 凭据                 | 说明                           |
| ------ | ------------------------- | -------------------- | ------------------------------ |
| POST   | `/api/auth/device/start`  | 无                   | CLI 申请登录会话               |
| POST   | `/api/auth/device/poll`   | 无                   | CLI 轮询；批准后一次性换 token |
| POST   | `/api/auth/device/decide` | OIDC / `approve` PAT | 人类确认（页面调用）           |
| GET    | `/cli-login`              | 浏览器会话           | 确认页（apps/web）             |
| GET    | `/api/auth/whoami`        | 任意                 | 凭据 + 成员身份 + 租户         |
| GET    | `/api/auth/tokens`        | 任意                 | 列出自己的凭据                 |
| POST   | `/api/auth/tokens`        | OIDC / `write` PAT   | 签发新凭据（明文一次性）       |
| DELETE | `/api/auth/tokens/:id`    | 任意                 | 撤销自己的凭据                 |

原有的 `/api/auth/me`（网关）不变；PAT 也可以调用它，返回同一个租户上下文契约。

作用域在 HTTP 面收口：

| 端点                                                        | 要求                                             |
| ----------------------------------------------------------- | ------------------------------------------------ |
| `POST /api/tools/*`（带 Authorization 时）                  | PAT 需要 `write`；审计 actor 记 `user:<subject>` |
| `POST /api/approvals/decide`                                | PAT 需要 `approve`                               |
| `GET /api/approvals`、`/api/approvals/:id`、`/api/panorama` | PAT 需要 `read`                                  |
| 改稿、导入、收款、分享管理等人类写操作                      | PAT 需要 `write`                                 |

OIDC 会话没有作用域概念，继续由 membership 角色 / RLS 约束。
不带 Authorization 的请求维持既有本地/演示行为；生产态直接 401，绝不静默按演示租户写账本。
带凭据时，`/api/tools/*` 与人类写操作一样走铁律 G4：认证成功后用 `openScope` 开一条
绑定该成员租户的会话内核，工具的读写与审计 `tenant_id` 由这条会话决定。

智能体不放大权限：AGENT 上下文携带的是**驱动者**的 `dataScope` / `ownerId`
（`POST /api/agents/quote` 同理）。OWN 成员驱动 `generate_quote_draft`、
`get_customer_history`、`create_sample_shipment` 时只看得到自己名下的客户，
越权客户一律按 `CUSTOMER_NOT_FOUND`（404）返回，与人类读路径同一套「当成不存在」的语义。
定价计算本身不受数据范围限制——收口在入口的归属判定，不在计价内部塞权限判断。

错误体保持网关契约：

```json
{ "error": { "code": "SCOPE_REQUIRED", "message": "当前凭据缺少 approve 作用域" } }
```

`AuthErrorCode` 是封闭集合（`packages/schema/src/auth.ts`），CLI 与 agent 据此分流。

### 4.1 工具面的 HTTP 状态码

`/api/tools/*` 与 `/api/approvals/decide` 的业务失败仍返回 `{ ok: false, error }` 形状，
但状态码不再是恒定的 201，由 `statusForToolFailure`（`packages/schema/src/common.ts`）
按 `code` / `reason` 映射，服务端拦截器、端侧 mock 与离线队列共用同一份：

| 状态码 | code / reason                                                 |
| ------ | ------------------------------------------------------------- |
| 400    | `INVALID_INPUT`（含请求体契约校验失败；不再冒 500）           |
| 403    | `PERMISSION_DENIED`                                           |
| 404    | `CUSTOMER_NOT_FOUND`、`RESOURCE_NOT_FOUND`                    |
| 409    | `KERNEL_REJECTED` + 冲突类 `reason`（`VERSION_CONFLICT` 等）  |
| 422    | `KERNEL_REJECTED` + 其它 `reason`、`AMOUNT_NOT_AUTHORITATIVE` |
| 502    | `UPSTREAM_UNAVAILABLE`                                        |

因为这批 4xx 表示「业务被拒」而不是「传输失败」，`packages/core` 的 API client、
移动端 transport 与 CLI 会把带 `{ ok: false, error }` 的 4xx 响应体原样当作返回值，
调用方继续用 `result.ok` 分支，无需改成 catch。

收口只认 `{ ok: false, error }` 这一种信封。另有两个路由用自己的失败形状，
失败时状态码仍是 201，调用方必须读 body 判分支，不能只看状态码：

| 端点                     | 失败信封                          |
| ------------------------ | --------------------------------- |
| `POST /api/agents/quote` | `status: "FAILED"` + `failure`    |
| `POST /api/import`       | `committed: false` + `batchError` |

## 5. CLI 安装与使用

```bash
pnpm install
pnpm --filter @weave-order/cli build

# 仓库内直接运行
node apps/cli/bin/weave.js --help
# 或链接到 PATH
cd apps/cli && pnpm link --global
```

```bash
weave login                            # 设备码登录（浏览器需已登录织序）
weave login --token wo_xxx             # 直接导入已有凭据
weave whoami                           # 账号 + 租户 + 角色 + 作用域
weave customers --limit 20 --json
weave tool search-by-spec --query "棉 平纹" --json
weave tool get-customer-history --customer-id <uuid> --json
weave tool generate-quote-draft --payload '{...}' --json
weave approvals --json
weave approve <id> --kind quote --note "价格可以"   # 需要 approve 作用域
weave token create 报价脚本 --scope read,write --days 90
weave token revoke <id|前缀>
weave skill install                    # 装到 ~/.codex/skills/weave-order/
```

配置与优先级：

1. `--server` / `--token` 参数
2. `WEAVE_SERVER` / `WEAVE_TOKEN` 环境变量（agent 首选，免落盘）
3. `~/.config/weave-order/config.json`（0600；`WEAVE_CONFIG_DIR` 可改）

退出码：`0` 成功 / `1` 业务失败 / `2` 用法错误 / `3` 凭据问题 / `4` 网络不可达。

> 本地没有 Casdoor 时，浏览器 BFF 与确认页都会回退 `DEV_AUTH_TOKEN`
> （默认 `dev:demo:demo`，生产绝不回退）。

## 6. 接入 codex 等 agent

```bash
weave skill install                 # 默认 codex: ~/.codex/skills/weave-order/SKILL.md
weave skill install --target claude
weave skill install --dir ./skills --force
```

skill 的 canonical 源文件是 `skills/weave-order/SKILL.md`，它告诉 agent：

- 先 `weave doctor --json` 自检；
- 用 `WEAVE_TOKEN` 而不是自己执行 `weave login`（避免卡在浏览器确认）；
- 写操作只产草稿，不得声称「已发出」；
- 审批前必须拿到用户对具体单据的明确同意；
- 失败如实转述 `error.code`，不编造成功。

推荐给 agent 的最小权限：

```bash
# 人类本人执行一次，签一枚只读 + 写草稿的凭据
weave token create codex --scope read,write --days 90
# 把 token 放进 agent 的环境（不要写进仓库）
export WEAVE_TOKEN=wo_xxx
export WEAVE_SERVER=https://app.weaveorder.cn
```

需要 agent 触发审批时，**不要**直接给它 `approve`。正确做法是 agent 把结果提交到
审批队列，人类在网页或自己的终端审批。

## 7. 凭据模型与安全清单

```
memberships ──1:N── api_tokens
memberships ──1:N── device_authorizations（CLI 登录会话）
```

- `api_tokens` 只存 `sha256(pepper + 明文 token)` 与可展示前缀 `wo_<publicId>`；
  明文只在创建那一刻返回一次。
- 撤销 = 写 `revoked_at`，不物理删除；撤销立即生效（每次请求校验状态）。
- `last_used_at` 每分钟最多更新一次，避免每个请求一次写入。
- token 形态：`wo_<10 位 publicId>_<32 位 secret>`；查找用 publicId，
  比较用 `timingSafeEqual`。
- 有效期可选（`--days N`），状态由服务端派生（`ACTIVE / REVOKED / EXPIRED`）。
- 设备码 / 确认码一次性、有 TTL、有轮询限速（`slow_down`）。

- [x] 明文不落库；哈希带生产必填 pepper（`PERSONAL_TOKEN_PEPPER`）
- [x] 凭据绑定 membership，PAT 仍走 RLS，不另开权限旁路
- [x] `approve` 默认不签发；低权凭据不能自我扩权
- [x] 签发 / 撤销写审计（`API_TOKEN_CREATED` / `API_TOKEN_REVOKED`）
- [x] 工具调用审计记录驱动者 `user:<subject>`
- [x] 确认页由 OIDC 会话决定归属，令牌不进浏览器脚本
- [x] 配置文件 0600、目录 0700
- [ ] token 轮换提醒 / 过期邮件（P1）
- [ ] MCP server（P1，见下）

## 8. 后续（不在本次范围）

- **MCP server**：把同一组工具暴露成 MCP，codex 等支持 MCP 的 agent 可以直接
  以工具形式调用，无需 shell。CLI 已把契约收敛为「命令 → HTTP → 工具 Schema」，
  MCP 只是再包一层传输。
- **清理匿名工具入口**：工具层目前未迁移到租户作用域内核；WAN-78 只在
  带 Authorization 时校验 PAT 作用域，后续随租户化一并收口。
- **速率限制**：网关层按 token 限流（Redis 已有）。
