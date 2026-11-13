---
name: weave-order
description: 操作织序 WeaveOrder（纺织贸易业务操作系统）：查客户/样品、按参数或以图找样、生成报价与寄样草稿、查看待审批与业务全景。当用户让你查纺织客户、面料样品、报价、寄样、订单或审批时使用。所有写操作只产出草稿，审批必须由人类确认。
---

# 织序 WeaveOrder

织序是纺织贸易的业务操作系统，核心前提是：**智能体干活，人类只审批**。
你通过 `weave` CLI 调用平台能力；所有写操作都停在 `DRAFT`（草稿），
人类批准后才生效。本 skill 说明如何安全、正确地使用这个 CLI。

## 0. 先确认可用性

```bash
weave doctor --json
```

- 退出码 0 且 `health.ok === true`：可用。
- 退出码 3：凭据问题 → 见下一节。
- 退出码 4：连不上服务 → 让用户确认 `WEAVE_SERVER` 或服务是否启动。

不要猜测数据：先 `weave doctor`，再执行具体命令。

## 1. 凭据从哪来

优先级：`WEAVE_TOKEN` 环境变量 > 本地 `weave login` 保存的凭据。

如果用户已经替你设置好 `WEAVE_TOKEN`，**不要**再执行 `weave login`
（设备登录会等待浏览器确认，在无人值守环境会卡住）。

只有用户明确要求登录且能在浏览器确认时，才运行：

```bash
weave login            # 打印确认码与链接，等用户在浏览器确认
weave login --no-browser
weave login --token wo_xxx   # 已有凭据时直接导入
```

登录页是织序网页的 `/cli-login`，要求浏览器里**已经登录织序**（Casdoor OIDC）；
凭据绑定的是那个登录账号的租户与角色。

检查当前身份与权限：

```bash
weave whoami --json
```

返回 `subject`、`tenant`（租户）、`membership`（角色 / 数据范围）与 `token`（作用域）。

返回 `token.scopes`：

| 作用域    | 能做什么                                          |
| --------- | ------------------------------------------------- |
| `read`    | 读客户、样品、审批队列、全景、审计                |
| `write`   | 调用工具：找样、客户 360、生成报价/寄样草稿、导入 |
| `approve` | 审批通过/驳回（人类决策）                         |

默认登录凭据只有 `read,write`。**没有 `approve` 就不要尝试审批**，
应提示用户：「需要一枚带 approve 作用域的凭据，请本人执行
`weave token create 审批终端 --scope read,write,approve` 后确认」。

千万不要打印、回显或转发 `WEAVE_TOKEN` / 配置文件内容。

## 2. 铁律（必须遵守）

1. **草稿不是生效**：`generate-quote-draft`、`create-sample-shipment` 都只返回
   `status: "DRAFT"`。不要对用户说「报价已发出」「寄样单已创建」。
2. **审批只能由人类发起**：执行 `weave approve` / `weave reject` 前，必须在
   同一次对话里拿到用户对该单据的明确同意（用户说「批准这个」「驳回并备注…」）。
   用户只说「看看有什么要审批的」时，只列队列，不要决策。
3. **金额以服务端为准**：报价返回值里有 `amountsComputedByKernel: true`；
   不要自己算总额，也不要改写 `lineTotal`。
4. **不创建、不撤销凭据**，除非用户明确要求。`weave token create` 的输出是一次性明文。
5. **失败要如实转述**：工具失败返回 `{ ok: false, error: { code, message } }`，
   把 `code` 与 `message` 告诉用户，不要编造成功结果。

## 3. 常用命令

所有命令都支持 `--json`，agent 场景请始终加 `--json`，直接解析 stdout。
人类可读文案走 stderr，不会污染 JSON。

### 查客户 / 样品

```bash
weave customers --limit 20 --json
weave samples --limit 50 --json
weave samples --limit 200 --json        # 找样前先看全集（上限 200）
```

### 按参数找样（T-002）

```bash
weave tool search-by-spec --query "棉 平纹" --json
weave tool search-by-spec --query "涤纶" --composition 涤纶 --limit 10 --json
```

返回：

```json
{
  "ok": true,
  "data": {
    "matches": [
      {
        "sample": { "id": "…", "code": "…", "name": "…" },
        "score": 0.83,
        "matchedOn": ["name", "composition"]
      }
    ]
  }
}
```

注意 `matchedOn` 是确定性字段（命中了哪些字段），不要编造匹配理由。
`score` 是命中占比，不是概率。

### 以图找样（T-001）

```bash
weave tool search-by-image --file ./fabric.jpg --top-k 5 --json
```

支持 jpeg / png / webp。图片只用于本次检索。

### 客户 360（T-003）

```bash
weave tool get-customer-history --customer-id <uuid> --limit 20 --json
```

返回客户档案、`context`（付款/价格/跟进偏好）、最近报价、订单、样品。
报价前先取这个，别让用户重复讲一遍历史。

### 生成报价草稿（T-004，只出 DRAFT）

```bash
weave tool generate-quote-draft --payload '{
  "customerId": "<uuid>",
  "currency": "CNY",
  "items": [
    { "fabricSampleId": "<uuid>", "quantity": { "value": 500, "unit": "meter" },
      "unitPrice": { "amount": 1280, "currency": "CNY" } }
  ],
  "validityDays": 30,
  "remarks": "含税，30% 定金"
}' --json
```

`unitPrice.amount` 是**分**（1280 = ¥12.80）。单价会被内核校验；
低于成本线会返回 `KERNEL_REJECTED`，把原因转述给用户，不要自己加价重试超过两次。

### 创建寄样单草稿（T-005，只出 DRAFT）

```bash
weave tool create-sample-shipment --payload '{
  "customerId": "<uuid>",
  "items": [ { "sampleId": "<uuid>", "quantity": { "value": 2, "unit": "piece" } } ],
  "channel": "COURIER",
  "note": "客户要看手感"
}' --json
```

`quantity` 的具体字段以服务端契约校验为准；不确定时先用 `--payload` 传最少的
必要字段，再根据错误 `issues` 补全。

### 待审批 / 全景 / 审计

```bash
weave approvals --json           # 只含 pending（DRAFT）单据
weave panorama --json            # 业务全景（只读）
weave audit --limit 20 --json    # 最近审计流水，含是谁触发的
```

`approvals` 每条有 `id`、`kind`（`quote` / `sample_shipment`）、`title`、
`summary`、`amountCents`、`currency`、`createdAt`。展示给用户时用 `title` 与金额。

### 审批（仅在用户明确同意后）

```bash
weave approve <id> --kind quote --note "价格可以，发" --json
weave reject  <id> --kind sample_shipment --note "运费太贵" --json
```

成功后返回决策回执；失败时常见 `SCOPE_REQUIRED`（凭据没有 approve 作用域）
或 `RESOURCE_NOT_FOUND`（单据已处理）。单据只能决策一次。

### 凭据管理（仅在用户明确要求时）

```bash
weave token list --json
weave token create 我的笔记本 --scope read,write --days 90 --json
weave token revoke <token-id 或前缀> --json
```

## 4. 推荐工作流

**「客户问一款布能不能做」**

1. `weave tool get-customer-history --customer-id <id> --json` 了解历史与偏好。
2. `weave tool search-by-spec --query "<关键词>" --json` 找候选样品。
3. 把候选（编号、成分、克重、为什么匹配）列给用户挑选。
4. 用户确认样品与数量后，`generate-quote-draft` 出草稿。
5. 明确告知：「草稿已生成，待你在审批窗口确认后才会发出」。

**「这批寄样到哪了 / 有什么要处理」**

1. `weave panorama --json` 看整体。
2. `weave approvals --json` 列待决策项，逐条解释金额与风险。
3. 等用户决定，再 `approve` / `reject`。

## 5. 错误与退出码

| 退出码 | 含义                        | 你的动作                             |
| ------ | --------------------------- | ------------------------------------ |
| 0      | 成功                        | 解析 stdout JSON                     |
| 1      | 业务失败（工具 `ok:false`） | 转述 `error.code` 与 `error.message` |
| 2      | 用法错误                    | 修正命令，别重复同样参数             |
| 3      | 凭据问题（401/403）         | 提示用户登录或缺作用域，不要自行登录 |
| 4      | 网络不可达                  | 提示用户检查 `WEAVE_SERVER` 或服务   |

`--json` 模式下错误也输出 JSON：`{ "ok": false, "error": { "code": "…", "message": "…" } }`。

常见 code：`AUTH_REQUIRED`、`INVALID_TOKEN`、`TOKEN_REVOKED`、`SCOPE_REQUIRED`、
`INVALID_INPUT`（含 `issues` 数组）、`CUSTOMER_NOT_FOUND`、`RESOURCE_NOT_FOUND`、
`KERNEL_REJECTED`、`PERMISSION_DENIED`。

## 6. 不要做的事

- 不要在没有用户明确同意时审批任何单据。
- 不要用 `write` 凭据伪装人类审批；平台会以 `SCOPE_REQUIRED` 拒绝。
- 不要编造样品、客户、报价或订单数据。
- 不要把 token 写进代码、日志、提交信息或聊天记录。
- 不要为了「让流程走通」而重试写操作超过两次；先向用户解释失败原因。
