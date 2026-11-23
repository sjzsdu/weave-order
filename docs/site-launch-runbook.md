# 官网上线手册（域名 / 搜索平台 / 统计）

> 对应 issue：WAN-113。适用对象：执行上线的人（老板或运维）。
> 官网的域名、备案号、搜索验证码、统计站点全部在部署时用环境变量注入，
> 同一份镜像可以服务任意域名；这份手册只讲「域名定下来之后要做什么、怎么验证」。

## 0. 上线前必须定下来的四件事

| 项目           | 谁定           | 影响                                                     |
| -------------- | -------------- | -------------------------------------------------------- |
| 正式域名       | 老板           | `WEAVE_SITE_URL`；canonical / OG / sitemap / llms 全跟着走 |
| 托管位置       | 运维           | 容器（compose）还是纯静态托管；决定缓存与跳转在哪一层做  |
| 备案主体与备案号 | 老板 + 运维  | 国内服务器必须展示 ICP 与公安备案号，未备案域名会被拦    |
| 统计服务       | 老板           | Plausible / PostHog 二选一；没有账号就先保持 `none`      |

域名没定之前能做的已经做完了（站点、SEO、埋点、运行期渲染）。
定下来之后按下面顺序执行。

## 1. 部署：只改环境变量，不重新构建

镜像里带的是 `apps/site/src/site.config.json` 的默认值；容器启动时
`apps/site/docker/start.sh` → `scripts/prepare-config.mjs` → `docker/entrypoint.sh`
按环境变量渲染。**不需要重新构建镜像、不需要重新发 tag。**

deploy 仓库 `.env` 最少要设：

```bash
WEAVE_SITE_URL=https://www.example.com     # 正式域名（带协议，不带结尾斜杠）
WEAVE_APP_URL=https://app.example.com      # 工作台
WEAVE_ADMIN_URL=https://admin.example.com  # 平台管理
WEAVE_SSO_URL=https://sso.example.com      # 统一登录
WEAVE_SUPPORT_EMAIL=hello@example.com      # 页脚与表单

# 国内服务器必填（不填则页脚不展示）
WEAVE_ICP_LICENSE=京ICP备2026000001号-1
WEAVE_PSB_LICENSE=京公网安备 11010502000001号

# 搜索平台用 HTML 标签验证时填；用 DNS 验证可不填
WEAVE_VERIFY_GOOGLE=
WEAVE_VERIFY_BING=
WEAVE_VERIFY_BAIDU=

# 统计（没有账号就保持 none）
WEAVE_ANALYTICS_PROVIDER=none
WEAVE_ANALYTICS_DOMAIN=
```

工作台侧另有两个变量要同步，否则登录页仍指向旧默认值：

```bash
NEXT_PUBLIC_MARKETING_URL=https://www.example.com
NEXT_PUBLIC_SUPPORT_EMAIL=hello@example.com
```

Casdoor 的 `weave-order-web` 应用 redirect URI 要包含 `<应用域名>/auth/callback`。

## 2. 启动后先看日志

```bash
docker compose up -d weave-site
docker compose logs weave-site | head -30
```

必须看到：

```
[site-render] 官网地址 → https://www.example.com
[site-render] 已渲染 N 个静态文件
[site-render] 访问统计 → provider=...
[site-render] 备案号   → ICP=... 公安=...
[site-render] 搜索验证 → Google=已配置 Bing= 百度=
```

`访问统计 → provider=none` 或验证码为空都是合法状态，但如果配置了却没生效，
日志会打出警告（非法字符、host 不是 https 等），先修环境变量再继续。

## 3. 自动核查（必须全绿）

```bash
pnpm --filter @weave-order/site launch:check --site https://www.example.com
# 或
node apps/site/scripts/launch-check.mjs --site https://www.example.com
```

它检查：

- `http://域名` → `https://域名`、裸域 ↔ www，各最多 1 次跳转，最终 200；
- 首页 200、canonical 是当前域名、TTFB / 总耗时在阈值内；
- `robots.txt` 里的 sitemap 是当前域名；
- `sitemap.xml` 20 条地址全部属于当前域名；
- `llms.txt` 200；
- OG 图绝对地址能打开且是图片；
- 不存在的路径返回 404（不是 200），且是站点自己的 404 页；
- HTML `Cache-Control: no-cache`，静态资源 `max-age ≥ 86400`；
- 文本响应有 gzip / br（没有只提醒，不放行失败）。

子域部署（如 `weave.wnbgj.com`）没有 `www` 时，脚本会对 www 归一化给一条提醒而不是失败；
也可以用 `--skip-www` 显式跳过。域名用 www 还是裸域要提前定死一个，另一个必须 301 过来。

脚本覆盖不到、必须人工看的：

- PageSpeed Insights 跑首页与价格页，手机 390px / 桌面 1440，LCP < 2.5s；
- 浏览器里实际点一遍：免费试用、登录、帮助中心搜索、页脚邮箱。

## 4. 搜索引擎提交

优先用 **DNS TXT** 做域名级验证：不依赖页面，换 www / 裸域都有效，
也不需要把验证文件塞进镜像。HTML 标签验证只是备用（填上面的 `WEAVE_VERIFY_*`）。

### Google Search Console

1. 添加「域名」资源（不是「网址前缀」），按提示加 DNS TXT；
2. 验证通过后提交 `https://www.example.com/sitemap.xml`；
3. 用「网址检查」抽查 4 页：`/`、`/pricing.html`、`/signup.html`、`/docs/`，
   确认「已编入索引」或请求编入索引；
4. 如果之前上线过临时域名：用「更改地址」把旧域名指向新域名，旧域名做 301。

### Bing Webmaster Tools

1. 用 Google Search Console 导入（最省事），或 DNS 验证；
2. 提交同一个 sitemap；
3. 检查「站点扫描」无阻塞项。

### 百度搜索资源平台（需备案后）

1. DNS 验证站点（备案号下来之后）；
2. 提交 sitemap；
3. 配置主动推送 token，写进部署环境变量 `BAIDU_PUSH_TOKEN`，然后：

```bash
pnpm --filter @weave-order/site baidu:push --site https://www.example.com --dry-run
BAIDU_PUSH_TOKEN=xxx pnpm --filter @weave-order/site baidu:push --site https://www.example.com
```

脚本读线上 `sitemap.xml`、只推同站地址；没配 token 时直接跳过并返回 0，
所以可以放心挂到发布流水线尾部。百度接口返回 `success=0` 时才返回非 0。

## 5. 统计后台

1. 在 Plausible 添加站点，domain 填**裸域**（`example.com`，不带协议与 www）；
   自建 Plausible 时把地址填进 `WEAVE_ANALYTICS_HOST`（必须 https）。
2. 部署环境设 `WEAVE_ANALYTICS_PROVIDER=plausible`、`WEAVE_ANALYTICS_DOMAIN=example.com`；
3. 重启官网容器，浏览器打开线上首页，Plausible 后台应出现 `pageview`；
4. 点首页「免费试用」按钮，Events 里应出现 `cta_click`，`location=hero`。

用 PostHog 时：`WEAVE_ANALYTICS_PROVIDER=posthog` + `WEAVE_ANALYTICS_KEY=phc_xxx`。
工作台统计由 `ANALYTICS_PROVIDER / DOMAIN / HOST / KEY` 服务端下发。

## 6. 换域名 / 回滚

- 站点 HTML、sitemap、txt 都是 `no-cache`；**前置 CDN 或反向代理不要再给 HTML 加缓存**，
  否则换域名后旧域名会残留在用户浏览器和 CDN 里。
- 已经上线过的域名要换：旧域名 301 到新域名（只跳一次），GSC 做「更改地址」，
  三家搜索平台重新提交新域名的 sitemap。没做 301 等于放弃已有收录。
- 回滚：把环境变量改回原值 + `docker compose up -d weave-site`，不需要回滚镜像。
  容器每次启动都会从原始产物重铺再渲染，换回旧域名同样生效。
- 证书：确认到期日并设置续期提醒（Let's Encrypt 90 天，提前 30 天续）。

## 7. 上线记录（部署后填写）

| 项目           | 值  |
| -------------- | --- |
| 正式域名       |     |
| 托管位置       |     |
| 镜像 tag       |     |
| 上线时间       |     |
| 证书到期日     |     |
| ICP 备案号     |     |
| 公安备案号     |     |
| 统计 provider  |     |
| GSC 资源       |     |
| Bing 站点      |     |
| 百度站点       |     |

上线当天把这张表填完，贴回 WAN-113 的评论里；以后换域名 / 换托管时一并更新。

## 8. 仍需人工确认的事项

- 域名与托管位置（决定 `WEAVE_SITE_URL` 和跳转在哪一层做）；
- 备案主体、备案号、公安备案号（国内节点）；
- 三家搜索平台的账号与站点所有权；
- 统计服务账号与站点创建；
- PageSpeed / 手机与桌面的人工走查结论。

代码侧已经就绪：域名、备案号、验证码、统计都能用环境变量切换，
`apps/site/tests/render.test.ts` 会在 CI 里守住这条链路。
