#!/bin/sh
# 官网静态站的启动脚本（跑在主镜像 weave-order 里）。
#
# 官网已经并入主镜像：它和 API / Web / Admin 共用同一个镜像，
# 靠 compose 的 command 选择进程 —— 与移动端 PWA 托管静态产物是同一种做法。
#
# 启动两件事：
#   1) 把部署环境的域名渲染进页面（canonical / OG / sitemap 要绝对地址）。
#      渲染逻辑复用 docker/entrypoint.sh：先把旧值换成占位符、再把占位符换成新值，
#      避免「官网新值恰好等于工作台旧值」这类串扰；邮箱先占位，不会被域名替换顺手改掉。
#   2) 用 Node 内置静态服务器托管渲染后的产物。
#
# 为什么要「复制一份再渲染」：渲染是就地改写，容器重启后文件里已经是旧域名，
# 不从原始产物重铺一遍的话，再换域名就替换不到了。
#
# 环境变量（与 deploy 仓库 compose 对齐，留空表示沿用 src/site.config.json 的默认值）：
#   WEAVE_SITE_URL       官网地址     → site
#   WEAVE_APP_URL        工作台地址   → app
#   WEAVE_ADMIN_URL      管理端地址   → admin
#   WEAVE_SSO_URL        统一登录地址 → sso
#   WEAVE_SUPPORT_EMAIL  支持邮箱     → email
#   PORT                 监听端口（Traefik 按 80 转发）
set -eu

APP_DIR="${APP_DIR:-/app}"
SITE_ROOT="${SITE_ROOT:-$APP_DIR/apps/site/dist}"
RENDER_DIR="${RENDER_DIR:-/tmp/weave-site}"
DEFAULTS_FILE="${DEFAULTS_FILE:-/tmp/weave-site-defaults.env}"

log() { echo "[site-start] $*"; }
die() { echo "[site-start] 错误：$*" >&2; exit 1; }

[ -d "$SITE_ROOT" ] || die "站点产物不存在：$SITE_ROOT"
[ -f "$APP_DIR/apps/site/src/site.config.json" ] || die "缺少 site.config.json"

# 运行时默认值：直接读镜像里的 site.config.json，
# 不用构建期生成的中间文件（主镜像里有 Node，现场解析更省一个环节）。
node "$APP_DIR/apps/site/scripts/prepare-config.mjs" \
  "$APP_DIR/apps/site/src/site.config.json" "$DEFAULTS_FILE"

# 渲染目标目录：每次启动都重新铺，容器重启后换域名同样生效。
rm -rf "$RENDER_DIR"
mkdir -p "$RENDER_DIR"

SITE_DIR="$RENDER_DIR" \
PRISTINE_DIR="$SITE_ROOT" \
DEFAULTS_FILE="$DEFAULTS_FILE" \
  sh "$APP_DIR/apps/site/docker/entrypoint.sh"

log "静态目录：$RENDER_DIR"

exec node "$APP_DIR/scripts/serve-static.mjs" "$RENDER_DIR" \
  --no-spa \
  --404 404.html \
  --no-cache-ext html,webmanifest,txt,xml \
  --asset-cache "public, max-age=2592000" \
  --gzip \
  --security-headers \
  --healthz
