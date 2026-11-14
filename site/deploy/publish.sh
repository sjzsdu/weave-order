#!/usr/bin/env bash
# 用 rsync 发布到已有的静态托管（nginx / 对象存储挂载目录）。
#
#   WEAVE_SITE_URL=https://weave.wnbgj.com \
#   DEPLOY_HOST=user@host DEPLOY_PATH=/var/www/weave-site \
#   ./site/deploy/publish.sh
#
# 会先在临时目录复制一份、按环境变量替换域名，再同步过去，不改工作区里的文件。
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${DEPLOY_HOST:?需要 DEPLOY_HOST，例如 user@server}"
: "${DEPLOY_PATH:?需要 DEPLOY_PATH，例如 /var/www/weave-site}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -R site "$tmp/site"
(
  cd "$tmp/site"
  WEAVE_SITE_URL="${WEAVE_SITE_URL:-}" \
  WEAVE_APP_URL="${WEAVE_APP_URL:-}" \
  WEAVE_ADMIN_URL="${WEAVE_ADMIN_URL:-}" \
  WEAVE_SSO_URL="${WEAVE_SSO_URL:-}" \
  WEAVE_SUPPORT_EMAIL="${WEAVE_SUPPORT_EMAIL:-}" \
  WEAVE_ANALYTICS_PROVIDER="${WEAVE_ANALYTICS_PROVIDER:-}" \
  WEAVE_ANALYTICS_DOMAIN="${WEAVE_ANALYTICS_DOMAIN:-}" \
  WEAVE_ANALYTICS_HOST="${WEAVE_ANALYTICS_HOST:-}" \
  WEAVE_ANALYTICS_KEY="${WEAVE_ANALYTICS_KEY:-}" \
  sh deploy/configure-env.sh
)

rsync -az --delete \
  --exclude 'tools' --exclude 'deploy' --exclude 'Dockerfile' \
  "$tmp/site/" "${DEPLOY_HOST}:${DEPLOY_PATH}/"

echo "已发布到 ${DEPLOY_HOST}:${DEPLOY_PATH}"
