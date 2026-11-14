#!/bin/sh
# 部署期用环境变量决定域名：给什么改什么，没给的保持 site.config.json 原值。
# 由 site/Dockerfile 的构建阶段调用，也可以在任何 Node 环境里直接跑。
set -eu

SITE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

args=""
add() {
  key="$1"; name="$2"
  eval "value=\"\${$name:-}\""
  if [ -n "$value" ]; then args="$args --$key $value"; fi
}

add site WEAVE_SITE_URL
add app WEAVE_APP_URL
add admin WEAVE_ADMIN_URL
add sso WEAVE_SSO_URL
add email WEAVE_SUPPORT_EMAIL

# 访问统计：与域名同样在部署期决定，写进 assets/analytics.config.js。
# 不填 provider 就不生成统计配置，页面完全静默。
add analytics-provider WEAVE_ANALYTICS_PROVIDER
add analytics-domain WEAVE_ANALYTICS_DOMAIN
add analytics-host WEAVE_ANALYTICS_HOST
add analytics-key WEAVE_ANALYTICS_KEY

if [ -z "$args" ]; then
  echo "[site] 没有提供 WEAVE_* 环境变量，沿用 site/site.config.json"
  exit 0
fi

# shellcheck disable=SC2086
node "$SITE_DIR/tools/configure.mjs" $args

# 域名变了，搜索索引里的链接也要跟着重算（索引存的是相对路径，通常不受影响，
# 这里顺手重建，保证内容也跟着最新页面）。
node "$SITE_DIR/tools/build-search-index.mjs"
