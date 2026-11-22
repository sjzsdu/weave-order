# Casdoor 登录页文案（部署侧）

> 这份清单对应 WAN-204 体验审计里的两条登录问题。它们发生在 `sso.wnbgj.com`
> 的 Casdoor 页面上，不经过本仓库的代码；应用侧的 `/login` 只能兜底清洗回跳错误。

## 1. 错误提示不要出现 `weave-order/用户名不存在`

Casdoor 对「用户不存在」的错误会拼成 `用户: <organization>/<username>不存在`。
`weave-order` 是 Casdoor 组织标识，用户不需要看到。

处理方式（二选一）：

- 把组织的 **Display name** 改成对用户有意义的名字（例如「万鸟科技」）。错误会变成
  `用户: 万鸟科技/haibao 不存在`，不再暴露内部标识。
- 或在 Casdoor 的 zh 语言包里覆盖这条错误文案，统一成
  「账号不存在或还没开通」。

改完以任意不存在的用户名登录一次，确认错误里没有 `weave-order` 或 `/`。

## 2. 空用户名的校验文案和占位符保持一致

当前输入框占位符是「用户名、Email或手机号」，空提交却提示「请输入您的Email或手机号!」，
漏掉了「用户名」这一合法输入方式。

在 Casdoor 的 zh 语言包（`web/src/locales/zh/data.json`）里把这句改成
「请输入用户名、邮箱或手机号」，与占位符一致。若线上是预构建镜像，需要重新构建并发布
Casdoor 前端资源。

## 应用侧已经做了什么

- `/login` 对回跳错误统一走 `friendlyLoginError`，不会再原样展示
  `weave-order/...`、HTTP 状态码、`invalid_grant` 等内部信息。
- `/login` 在「使用公司账号登录」下方明确写出「用户名、邮箱或手机号都可以登录」，
  即使 Casdoor 自己的提示仍不完整，用户在点击前也能知道三种都行。

## 验证

1. `https://app.wnbgj.com/login?error=用户%3A%20weave-order%2Fwho%20不存在`
   只显示「账号不存在或还没开通…」。
2. `https://sso.wnbgj.com` 用不存在的用户名登录，错误里不再出现 `weave-order`。
3. 清空用户名直接提交，提示包含「用户名」。
