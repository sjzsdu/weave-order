# @weave-order/quote · E3 客户报价链接页

客户在微信里点开就能看的**无登录只读报价页**：`/s/[token]`。

- 技术栈：Next.js 15（App Router）+ React 19 + TypeScript；SSR 渲染、`force-dynamic` 不吃 CDN 缓存。
- 零鉴权 Cookie、零第三方脚本、`noindex`；只渲染客户可见字段（`CustomerQuoteView`）。
- 客户可以：查看明细/条款、接受报价（可选手机尾号验证）、留言提问、打印/另存 PDF。
- 业务员可以：在租户端「生成报价链接」，看到访问次数 / 独立访客 / 是否接受 / 客户留言。

## 本地运行

```bash
# 根目录
pnpm install
docker compose up -d
pnpm db:migrate
pnpm demo                      # 可选：造演示数据

pnpm --filter @weave-order/api dev     # API :3000
pnpm --filter @weave-order/web dev     # 租户端 :5173（审批 / 生成链接）
pnpm --filter @weave-order/quote dev   # 客户页 :5174（/s/[token]）
```

生成链接：租户端「审批与异常分诊」批准一条报价 → 点「生成报价链接」；
或「业务全景」里对 `SENT` 报价点「分享 / 访问数据」。

## 环境变量

| 变量                             | 作用                                                   | 默认                    |
| -------------------------------- | ------------------------------------------------------ | ----------------------- |
| `QUOTE_API_BASE_URL`             | **服务端 SSR** 直连 API 的地址                         | `http://localhost:3000` |
| `NEXT_PUBLIC_QUOTE_API_BASE_URL` | 浏览器接受/提问时直连 API 的地址（CORS 已在 API 开启） | `http://localhost:3000` |
| `PUBLIC_APP_URL`                 | API 生成分享 URL 时的站点根地址，必须是本应用          | `http://localhost:5174` |
| `QUOTE_SHARE_SECRET`             | API 侧 HMAC 密钥（≥32 字节），轮换会让所有旧链接失效   | 仅开发默认值            |

生产建议把 API 与客户页放在同一域名下（`/api` 与 `/s` 反代到两个服务），
这样 `NEXT_PUBLIC_QUOTE_API_BASE_URL` 可留空字符串走同源。

## 路由

| 路由                      | 说明                                                 |
| ------------------------- | ---------------------------------------------------- |
| `/s/[token]`              | 客户视图；服务端校验 token 后 SSR，记录一次 `VIEWED` |
| `/s/[token]/print?lang=zh | en`                                                  | 打印/另存 PDF；`?track=0` 读取不重复计浏览，进入即记 `PDF_DOWNLOADED` |

`basePath: "/s"`，因此 `app/[token]/page.tsx` 对外就是 `/s/<token>`。

## 安全模型

1. **签名 token 自带租户**：`token = base64url({t: tenantId, s: shareId, n: nonce}) + "." + HMAC-SHA256`。
   验签后才知道去哪个租户会话，**不存在跨租户的 owner 查询**；RLS 始终生效。
2. **只存哈希**：数据库 `quote_shares.token_hash = sha256(token)`，明文只在生成响应里出现一次。
3. **四道门**：签名有效 + 哈希命中 + 未撤回 + 未过期；任一失败分别返回 404 / 410。
4. **手机尾号**：可选，比对客户联系人手机号后 4 位；不注册、不存明文。
5. **接受 ≠ 合同**：只写一条 `ACCEPTED` 事件，报价账本保持 `SENT`；由业务员确认后转订单草稿。
6. **隐私最小化**：不写追踪 Cookie；IP / UA 只存加盐哈希；不做第三方埋点。
7. **水印**：页面与打印版都把「客户名 + 报价编号」铺满背景。

## 测试

```bash
pnpm --filter @weave-order/quote test      # 金额/数量/日期/中英文案
pnpm --filter @weave-order/api test        # 含 share.integration / share.http.e2e（需本地 PG）
```

## 当前边界

- PDF 走浏览器打印（另存为 PDF），由服务端记录下载事件；尚未接服务器端二进制 PDF 渲染。
- 销售名片读租户配置 `tenants.settings.salesContact = { name, phone, wechatQrUrl }`：
  页面只输出脱敏电话（`138****6621`）与可选微信二维码；未配置则不展示该区块。
- 条款文本读取 `tenants.settings.quoteTerms`（字符串）；未配置时用产品默认条款。
- 报价版本号读取 `quotes.version`（Track A 起提供）；当前分支若尚未合入该字段则回退为 `1`。
