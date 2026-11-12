# 用户凭据、CLI 与 agent 接入（WAN-78）

> 目标：让每个用户拥有自己的凭据，并能从织序之外的 agent（codex 等）安全地操作织序。
> 一句话：**人类登录一次，agent 拿着「只能干活、不能审批」的 token 调用工具，草稿回到审批窗口由人确认。**

## 1. 为什么这样设计

产品铁律决定了凭据的形态：

| 铁律               | 对凭据的要求                                       |
| ------------------ | -------------------------------------------------- |
| 智能体是默认操作者 | agent 必须能独立调用工具，不能靠人点页面           |
| 写操作只出草稿     | agent 的 token 需要 `write`，但不需要 `approve`    |
| 审批只能由人类发起 | `approve` 作用域必须显式授予，默认登录不给         |
| 每一步都有审计     | 签发 / 撤销 token 写审计；工具调用记录 `user:<id>` |

因此用**三档作用域**而不是「一把万能 key」：

| 作用域    | 允许                                     | 典型持有者            |
| --------- | ---------------------------------------- | --------------------- |
| `read`    | 客户、样品、审批队列、全景、审计         | 任何 agent / 只读看板 |
| `write`   | 找样、客户 360、报价草稿、寄样草稿、导入 | codex / 自动化脚本    |
| `approve` | 审批通过 / 驳回                          | 人类本人的终端        |

默认登录（`weave login`）签发 `read,write`。这意味着即使 agent 完全控制了这个
token，也无法自己把草稿变成生效单据——它最多把草稿堆满审批窗口，而这是**可见
且可撤销**的。

## 2. 凭据模型

```
users ──1:N── api_tokens
users ──1:N── device_authorizations（CLI 登录会话）
```

- `api_tokens` 只存 `sha256(pepper + 明文 token)` 与可展示前缀 `wo_<publicId>`；
  明文只在创建那一刻返回一次。
- 撤销 = 写 `revoked_at`，不物理删除；撤销立即生效（每次请求校验状态）。
- `last_used_at` 每分钟最多更新一次，避免每个请求一次写入。
- token 形态：`wo_<10 位 publicId>_<32 位 secret>`，publicId 用于查找，
  比较用 `timingSafeEqual`。
- 有效期可选（`--days N`），过期状态由服务端派生（`ACTIVE / REVOKED / EXPIRED`）。

## 3. CLI 登录：设备码流程

```
CLI                          API                        浏览器
 │  POST /api/auth/device/start │                           │
 │◀── deviceCode + userCode ────│                           │
 │                              │  打开 /cli-login?user_code │
 │                              │◀──── 填邮箱，点「批准」────│
 │                              │  POST /api/auth/device/decide
 │  POST /api/auth/device/poll  │                           │
 │◀── approved + 明文 token ────│（一次性消费，重放被拒）    │
 │  保存 ~/.config/weave-order/config.json (0600)            │
```

- `deviceCode` 40 位随机串，只存哈希；`userCode` 8 位易读字符，10 分钟有效、只能用一次。
- 轮询过快返回 `slow_down`（间隔 +5s），CLI 自动退避。
- 拒绝 / 过期 / 已使用都有明确终态，不会静默卡住。
- `weave login --token <token>` 支持直接导入已有凭据（CI、远程 agent 环境）。

### 当前限制（必须知道）

确认页用**邮箱自证**（没有密码、没有 OIDC 会话），因为租户端登录尚未接入
Casdoor。这意味着：

- 只适合本地 / 可信内网；
- **对外网暴露前必须接入 Casdoor**：把 `/cli-login` 换成租户端受保护路由，
  用 OIDC 会话里的 `sub + org` 作为身份，`email` 字段随之删除。

代码结构已经按这个演进方向切开：`AuthService.decideDevice` 只依赖
「已经确认的人类身份（email / userId）」，换身份来源不动 token 逻辑。

## 4. HTTP 面

| 方法   | 路径                      | 凭据             | 说明                           |
| ------ | ------------------------- | ---------------- | ------------------------------ |
| POST   | `/api/auth/device/start`  | 无               | CLI 申请登录会话               |
| POST   | `/api/auth/device/poll`   | 无               | CLI 轮询；批准后一次性换 token |
| POST   | `/api/auth/device/decide` | 无（浏览器确认） | 批准 / 拒绝                    |
| GET    | `/cli-login`              | 无               | 确认页（HTML）                 |
| GET    | `/api/auth/me`            | 任意             | 当前账号 + 凭据                |
| GET    | `/api/auth/tokens`        | 任意             | 列出自己的凭据                 |
| POST   | `/api/auth/tokens`        | `write`          | 签发新凭据（一次性明文）       |
| DELETE | `/api/auth/tokens/:id`    | 任意             | 撤销自己的凭据                 |

业务端点的作用域要求：

| 端点                                                                                  | 作用域                                      |
| ------------------------------------------------------------------------------------- | ------------------------------------------- |
| `GET /api/customers`、`/api/samples`、`/api/panorama`、`/api/audit`、`/api/approvals` | `read`                                      |
| `POST /api/tools/*`                                                                   | `write`（`get-customer-history` 为 `read`） |
| `POST /api/approvals/decide`                                                          | `approve`                                   |
| `POST /api/import`                                                                    | `write`                                     |

错误体统一为：

```json
{ "error": { "code": "SCOPE_REQUIRED", "message": "当前凭据缺少 approve 作用域：…" } }
```

`code` 是封闭集合（`packages/schema/src/auth.ts` 的 `AuthErrorCode` 加上工具错误码），
CLI 与 agent 据此分流，不解析文案。

### 开发模式的匿名降级

`AUTH_REQUIRED=false`（默认，且非 production）时，**没带** `Authorization` 的请求
仍然放行，保证既有的三窗口页面不需要登录即可演示。带了凭据则一定校验。

生产环境（`NODE_ENV=production` 或 `AUTH_REQUIRED=true`）下所有端点都要求凭据。

## 5. CLI 安装与使用

```bash
pnpm install
pnpm --filter @weave-order/cli build

# 仓库内直接运行
node apps/cli/bin/weave.js --help
# 或链接到 PATH
cd apps/cli && pnpm link --global   # 之后可用 weave（回到仓库根目录）
```

```bash
weave login                            # 设备码登录
weave whoami                           # 账号 + 作用域
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

## 7. 安全清单

- [x] token 只存哈希 + 前缀；明文一次性返回
- [x] 常量时间比较；无效 token 与不存在 token 统一 `INVALID_TOKEN`
- [x] 设备码 / 确认码一次性、有 TTL、有轮询限速
- [x] 撤销立即生效；过期由服务端判定
- [x] 签发 / 撤销写审计（`API_TOKEN_CREATED` / `API_TOKEN_REVOKED` / `USER_CREATED`）
- [x] 工具调用审计记录 `user:<id>`，能追到是谁驱动的 agent
- [x] 配置文件 0600、目录 0700
- [x] `approve` 默认不签发，必须显式授予
- [ ] 确认页替换为 Casdoor OIDC 会话（上线前必做）
- [ ] token 轮换提醒 / 过期邮件（P1）

## 8. 后续（不在本次范围）

- **MCP server**：把同一组工具暴露成 MCP，codex 等支持 MCP 的 agent 可以直接
  以工具形式调用，无需 shell。CLI 已经把这层契约收敛成
  「命令 → HTTP 端点 → 工具 Schema」，MCP 只是再包一层传输。
- **Casdoor 登录**：`users` 增加 `idp_subject`，`/api/auth/device/decide` 改用会话身份。
- **租户隔离**：token 绑定 `tenant_id`，RLS 在连接层生效。
- **速率限制**：网关层按 token 限流（Redis 已有）。
