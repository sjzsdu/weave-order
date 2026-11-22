# 实体样卡（P0b）

确认报价之后，一键把「报价里的样品」变成可以跟着样品走的纸片：A4 样卡或 80×50mm 热敏标签。
扫码只回答两个问题——这是哪个样品、找谁。

## 用户路径

```
报价详情（已确认价格）
  └─ 打印样卡
       ├─ 选版面：A4 样卡 / 80×50 标签（ZPL）/ 80×50 标签（TSPL）
       ├─ 预览：版式预览（模板）｜ 打印 PDF（真正入队的文件）
       ├─ 打印：入队，代理在线自动出纸
       └─ 打印记录：状态 + 补打（必须选原因）
```

未确认价格（`DRAFT`）的报价不能预览、不能打印：草稿信息跟着样品流出去比打不出来更糟。

### 独立样品标签（不依赖报价）

样品本身也是可打印单据：样品图墙卡片与样品详情都有「打印标签」入口，按 `sampleId` 直接预览、入队、查记录与补打。标签字段取自样品，二维码与报价样卡共用同一枚确定性 token；扫码看到样品属性与业务员联系方式，不需要先在报价里确认价格。

```
样品图墙 / 样品详情
  └─ 打印标签
       ├─ 默认 80×50 标签（ZPL / TSPL），可选 A4 样卡
       ├─ 预览：服务端同一份打印产物
       ├─ 打印：按 sampleId 入队
       └─ 打印记录：状态 + 补打（必须选原因）
```

## 数据来源

| 卡面字段                             | 来源                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 公司名 / 品牌                        | `tenants.name` / `tenants.brand`                                                                                     |
| 样品编号 / 名称 / 成分 / 克重 / 品类 | `samples`                                                                                                            |
| 报价编号                             | `quotes`（`BJ-YYYYMMDD-XXXX`）                                                                                       |
| 业务员姓名 / 电话                    | `tenants.settings.salesContact`，姓名缺失时回落到报价确认人 / 客户负责人的成员姓名，电话回落到 `settings.printPhone` |
| 二维码                               | 签名 URL `{PUBLIC_APP_URL}/s/sample/{token}`                                                                         |

**卡面与二维码都不含价格、客户名、成本与内部 UUID。** 二维码 token 是确定性的 HMAC
（租户 + 样品编号），所以预览里的码与纸上、补打后的码完全一致；改一个字符即失效。

设置页里可以直接改这份名片（`GET/PATCH /api/settings/sales-contact`，需要 `settings.edit`）。
留空可以保存，但打印样卡前必须有电话，否则报 `PRINT_MISSING_FIELD` 并指明缺哪一项。

## 接口

| 方法 | 路径                                   | 说明                                                                                     |
| ---- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| POST | `/print/preview`                       | `{ quoteId \| sampleId, lineIndex?, format: HTML\|ZPL\|TSPL }`，返回本次打印会用的产物    |
| POST | `/print/sample-labels/:sampleId/preview` | 独立样品标签预览，默认 ZPL 80×50                                                      |
| POST | `/print/jobs`                          | `{ kind: "SAMPLE_LABEL", quoteId \| sampleId, lineIndex?, format?, copies }`，单张入队   |
| POST | `/print/sample-labels/:sampleId`       | 独立样品标签入队，默认 ZPL 80×50                                                       |
| GET  | `/print/jobs/:id`                      | 任务详情（不含载荷）                                                                     |
| POST | `/print/sample-cards/:quoteId`         | 报价每行一张，一键入队                                                                   |
| GET  | `/print/sample-cards/:quoteId`         | 打印记录（补打入口）                                                                     |
| POST | `/print/sample-cards/:quoteId/reprint` | `{ reason, lineIndex?, format?, copies? }`，补打                                         |
| GET  | `/print/sample-labels/:sampleId`       | 独立样品标签打印记录                                                                     |
| POST | `/print/sample-labels/:sampleId/reprint` | `{ reason, format?, copies? }`，独立标签补打                                            |
| GET  | `/api/public/sample-cards/:token`      | 扫码公开面：样品属性 + 业务员联系方式（无价格/客户/成本）                                |

幂等键 = 单据（报价 id 或样品 id）+ 模板版本 + 份数 + 操作人（报价样卡再加行号与补打序号）。
同一操作人重复点「打印」只有一条任务；更换操作人/模板或补打才生成新任务。
补打只新增打印任务，不新增样品。

## 输出与版面

- **A4**：`renderSampleCardPdf` 优先把 HTML 模板交给 Chromium 渲染；部署里没有 Chromium 时
  用 pdf-lib 内置版式兜底（版面仍是样卡，不是订单表格）。因为兜底字体不含拉丁字形，
  编号/电话按字符集切段用 Helvetica + 中文兜底字体绘制。
- **80×50 标签**：ZPL（`^PW640 ^LL400`）或 TSPL（`SIZE 80 mm,50 mm`），二维码由打印机指令生成。
  热敏不走浏览器直打，仍由 `apps/print-agent` 领任务下发。
  - 二维码内容做了紧凑化（二进制 token，典型 50 字符），5 点/模块时不超过 225 点，
    在 400 点高的标签内不越界。最初用 JSON+完整签名的 120 字符 token，
    203dpi 实测二维码被标签底边裁掉（0/40 可解码），已修。
  - **中文依赖设备字库**：ZPL `^A0N` 用打印机内置字体，未装 CJK 字库时中文不打印
    （编号/电话/二维码不受影响）；TSPL 走 TSC 内置 `TSS` 中文字体。实物验收要记录机型。

字段长度按 80×50mm 版面折算上限（`SAMPLE_CARD_LIMITS`）。超过上限直接报
`PRINT_FIELD_OVERFLOW`，缺必填字段报 `PRINT_MISSING_FIELD`——**不截断、不留空**。

样品编号还要满足 token 容量：**≤32 字符且 ≤32 UTF-8 字节**（中文按 3 字节计）。
token 是紧凑二进制 `[版本][tenant 16B][codeLen][code][HMAC 12B]`；编号超字节上限时
在生成 token 前就抛 `PRINT_FIELD_OVERFLOW`（HTTP 400），而不是 500。

机器可复现的验收证据（对照图、40 张标签解码记录、可重跑的 `verify-sample-card-qr.py`）在 `docs/acceptance/wan-198/`。

## 自验

```bash
# 真实数据跑通「确认报价 → 预览 → 入队」，产物落 apps/api/.artifacts/sample-card
pnpm --filter @weave-order/api verify:sample-card

# 单测 + 集成（真连 PG）
pnpm --filter @weave-order/api exec vitest run test/sample-card.unit.test.ts test/sample-card.integration.test.ts
```

## 实物验收（需要硬件，属创始人手工步骤）

1. 用 `verify:sample-card` 产出的 `preview.pdf` 打到 A4 打印机，核对与预览一致（不应出现截断）。
2. 把 `label.zpl`（或 TSPL 模板渲染结果）发给 80×50 热敏机，核对二维码可扫。
3. 打印 40 张，逐张扫码，记录设备型号与纸张型号；扫码页应只显示样品编号与业务员电话。

自动化能保证的是「同一份数据、同一条渲染路径、同一套字段校验」，**打不出纸、扫不出码
属于设备与耗材问题，必须实物验证后才能把 P0b 视为验收通过**。
