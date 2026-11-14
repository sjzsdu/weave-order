#!/bin/sh
# 容器启动时按部署环境渲染官网：域名、应用/管理端地址、支持邮箱都在这里生效。
# nginx 官方入口会依次执行 /docker-entrypoint.d/*.sh，本脚本排在 40，之后才起 nginx。
#
# 幂等：site/tools/configure.mjs 读 site/site.config.json 的当前值做替换；
# 变量与当前值一致时不改任何文件，重启容器不会累积改动。
# 变量全空时保持镜像内默认值，日志会说明一句，便于排查"域名没生效"。
set -eu

SITE_DIR=/usr/share/nginx/html

echo "[weave-site] 配置域名：site=${WEAVE_SITE_URL:-<默认>} app=${WEAVE_APP_URL:-<默认>} admin=${WEAVE_ADMIN_URL:-<默认>} sso=${WEAVE_SSO_URL:-<默认>} email=${WEAVE_SUPPORT_EMAIL:-<未配置>} analytics=${WEAVE_ANALYTICS_PROVIDER:-none}"

sh "$SITE_DIR/deploy/configure-env.sh"
