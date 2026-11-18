#!/usr/bin/env bash
#
# dev-storage-up.sh — 本地对象存储（S3 兼容）不依赖 Docker Hub 的起停脚本。
#
# 背景：国内/受限网络下 registry-1.docker.io 不可达，`docker compose up` 拉不到
# minio/minio 镜像，导致 S1 的本地验收链路无法真机验证。这里改用 MinIO 单文件
# 二进制（官方国内镜像 dl.minio.org.cn）直接在本机跑服务，端口、凭据、bucket 与
# docker-compose.yml 里的 minio 完全一致，API 侧不用改任何配置。
#
# 用法：
#   scripts/dev-storage-up.sh            # 下载（首次）+ 启动 + 建桶 + 开放匿名读
#   scripts/dev-storage-up.sh status     # 看进程 / 健康 / bucket
#   scripts/dev-storage-up.sh down       # 只停本脚本启动的那个进程
#   scripts/dev-storage-up.sh logs       # tail 日志
#   scripts/dev-storage-up.sh env        # 打印可供 shell 使用的环境变量
#
# 可覆盖（与 .env 默认值一致）：
#   MINIO_PORT=9000 MINIO_CONSOLE_PORT=9001
#   S3_ACCESS_KEY_ID=weave-media S3_SECRET_ACCESS_KEY=weave-media-secret S3_BUCKET=weave-media
#   STORAGE_HOME=<repo>/.dev-storage       # 二进制、数据、日志、pid 都在这
#   MINIO_VERSION / MC_VERSION             # 固定版本，避免“最新版”漂移
#   MINIO_DOWNLOAD_MIRRORS="https://dl.minio.org.cn"   # 官方 dl.min.io 已 410 下架
#   MINIO_CURL_UA="..."                    # 默认浏览器 UA，规避 Cloudflare 对 datacenter IP 的 403
#   ALLOW_UNVERIFIED_DOWNLOAD=1            # 仅在镜像站缺 .sha256sum 时显式放开
#
# 退出码：0 就绪；1 失败（原因打印在 stderr，日志在 $STORAGE_HOME/minio.log）。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORAGE_HOME="${STORAGE_HOME:-$ROOT/.dev-storage}"
BIN_DIR="$STORAGE_HOME/bin"
DATA_DIR="$STORAGE_HOME/data"
RUN_DIR="$STORAGE_HOME/run"
MC_CONFIG_DIR="$STORAGE_HOME/mc"
LOG_FILE="$STORAGE_HOME/minio.log"
PID_FILE="$RUN_DIR/minio.pid"

# 官方镜像站同时提供 linux/darwin × amd64/arm64，开发机是哪种就取哪种。
case "$(uname -s)" in
  Linux) STORAGE_OS=linux ;;
  Darwin) STORAGE_OS=darwin ;;
  *) printf '[storage] ERROR: 不支持的平台 %s（仅 linux / darwin）\n' "$(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) STORAGE_ARCH=amd64 ;;
  arm64 | aarch64) STORAGE_ARCH=arm64 ;;
  *) printf '[storage] ERROR: 不支持的架构 %s\n' "$(uname -m)" >&2; exit 1 ;;
esac
MINIO_PLATFORM="$STORAGE_OS-$STORAGE_ARCH"

MINIO_PORT="${MINIO_PORT:-9000}"
MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9001}"
S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-weave-media}"
S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-weave-media-secret}"
S3_BUCKET="${S3_BUCKET:-weave-media}"

MINIO_VERSION="${MINIO_VERSION:-RELEASE.2025-07-23T15-54-02Z}"
MC_VERSION="${MC_VERSION:-RELEASE.2025-07-21T05-28-08Z}"
# 官方 dl.min.io 归档已整体 410 下架（2026-11 实测全部版本均 410），只保留国内镜像。
MINIO_DOWNLOAD_MIRRORS="${MINIO_DOWNLOAD_MIRRORS:-https://dl.minio.org.cn}"
# dl.minio.org.cn 走 Cloudflare，对 datacenter IP + curl 默认 UA 会返回 403；
# 用浏览器 UA 规避 bot 拦截，CI（GitHub Actions 海外 runner）上必须带。
MINIO_CURL_UA="${MINIO_CURL_UA:-Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36}"
ALLOW_UNVERIFIED_DOWNLOAD="${ALLOW_UNVERIFIED_DOWNLOAD:-0}"

MINIO_BIN="$BIN_DIR/minio.$MINIO_VERSION.$MINIO_PLATFORM"
MC_BIN="$BIN_DIR/mc.$MC_VERSION.$MINIO_PLATFORM"
MC=( "$MC_BIN" --config-dir "$MC_CONFIG_DIR" )
ENDPOINT="http://127.0.0.1:$MINIO_PORT"

log() { printf '[storage] %s\n' "$*"; }
err() { printf '[storage] ERROR: %s\n' "$*" >&2; }

# 下载并校验：先取 .sha256sum，再取二进制；任何一步失败就换镜像。
download_verified() {
  local remote_path="$1" dest="$2" label="$3"
  local mirror url sha_url expected tmp
  for mirror in $MINIO_DOWNLOAD_MIRRORS; do
    url="$mirror$remote_path"
    sha_url="$url.sha256sum"
    tmp="$dest.download.$$"
    log "下载 $label <- $url"
    if ! curl -fL -A "$MINIO_CURL_UA" --retry 3 --retry-delay 2 --connect-timeout 10 -o "$tmp" "$url"; then
      rm -f "$tmp"; log "  $mirror 不可用，换下一个"; continue
    fi
    if expected="$(curl -fsSL -A "$MINIO_CURL_UA" --connect-timeout 10 "$sha_url" | awk '{print $1}' | head -n1)" && [ -n "$expected" ]; then
      if ! printf '%s  %s\n' "$expected" "$tmp" | sha256sum -c --status -; then
        rm -f "$tmp"
        err "${label} 校验和不匹配（${mirror}），拒绝安装"
        return 1
      fi
      log "  校验和 OK（${expected:0:12}…）"
    elif [ "$ALLOW_UNVERIFIED_DOWNLOAD" = "1" ]; then
      log "  警告：$sha_url 不可用，按 ALLOW_UNVERIFIED_DOWNLOAD=1 跳过校验"
    else
      rm -f "$tmp"
      err "${label} 校验和不可用（${sha_url}）；为供应链安全拒绝安装。确认可信可设 ALLOW_UNVERIFIED_DOWNLOAD=1"
      return 1
    fi
    chmod +x "$tmp"
    mv -f "$tmp" "$dest"
    return 0
  done
  return 1
}

ensure_binaries() {
  mkdir -p "$BIN_DIR" "$DATA_DIR" "$RUN_DIR" "$MC_CONFIG_DIR"
  if [ ! -x "$MINIO_BIN" ]; then
    download_verified "/server/minio/release/$MINIO_PLATFORM/archive/minio.$MINIO_VERSION" "$MINIO_BIN" "minio $MINIO_VERSION ($MINIO_PLATFORM)" || {
      err "minio 二进制下载失败"; exit 1; }
  fi
  if [ ! -x "$MC_BIN" ]; then
    download_verified "/client/mc/release/$MINIO_PLATFORM/archive/mc.$MC_VERSION" "$MC_BIN" "mc $MC_VERSION ($MINIO_PLATFORM)" || {
      err "mc 二进制下载失败"; exit 1; }
  fi
}

health_ok() {
  curl -fsS --max-time 2 "$ENDPOINT/minio/health/live" >/dev/null 2>&1
}

# 只认 PID 文件里、且命令行确实是本目录 minio 的进程；避免误杀同机其它 minio。
our_pid() {
  local pid
  [ -f "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' <"/proc/$pid/cmdline" | grep -Fq "$DATA_DIR"; then
    printf '%s' "$pid"; return 0
  fi
  # macOS（无 /proc）：退回 ps 命令行匹配
  if ps -p "$pid" -o command= 2>/dev/null | grep -Fq "$DATA_DIR"; then
    printf '%s' "$pid"; return 0
  fi
  return 1
}

wait_ready() {
  local i
  for i in $(seq 1 60); do
    health_ok && return 0
    sleep 0.5
  done
  return 1
}

ensure_bucket() {
  "${MC[@]}" alias set weave-local "$ENDPOINT" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null || {
    err "mc alias 认证失败（检查 S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY 是否与启动 MinIO 时一致）"; return 1; }
  "${MC[@]}" mb --ignore-existing "weave-local/$S3_BUCKET" >/dev/null || {
    err "建桶失败：$S3_BUCKET"; return 1; }
  # 本地专用：匿名下载，让 MEDIA_BASE_URL 直接可看（生产用 CDN / 私有桶签名 URL）。
  "${MC[@]}" anonymous set download "weave-local/$S3_BUCKET" >/dev/null || {
    err "开放匿名读失败：$S3_BUCKET"; return 1; }
}

cmd_up() {
  ensure_binaries
  local pid
  if pid="$(our_pid)"; then
    if health_ok; then
      log "已在运行（pid ${pid}）"
    else
      log "进程存在（pid ${pid}）但健康检查未通过，重启"
      cmd_down
      cmd_up
      return
    fi
  else
    rm -f "$PID_FILE"
    if health_ok; then
      err "端口 $MINIO_PORT 上已有其它 MinIO/S3 服务在响应，但不受本脚本管理；先停掉它或设 MINIO_PORT 换端口"
      exit 1
    fi
    log "启动 MinIO ${MINIO_VERSION}（数据：${DATA_DIR}）"
    # root 凭据直接取 S3_* 变量，保证 API / mc / compose 三方看到的是同一套。
    MINIO_ROOT_USER="$S3_ACCESS_KEY_ID" MINIO_ROOT_PASSWORD="$S3_SECRET_ACCESS_KEY" \
    nohup "$MINIO_BIN" server "$DATA_DIR" \
      --address "127.0.0.1:$MINIO_PORT" \
      --console-address "127.0.0.1:$MINIO_CONSOLE_PORT" \
      >"$LOG_FILE" 2>&1 &
    pid=$!
    printf '%s' "$pid" >"$PID_FILE"
    if ! wait_ready; then
      err "10 秒内未就绪；最近日志："
      tail -n 30 "$LOG_FILE" >&2 || true
      exit 1
    fi
  fi
  ensure_bucket || { err "bucket 初始化失败；日志：$LOG_FILE"; exit 1; }
  log "就绪"
  cmd_env
}

cmd_down() {
  local pid
  if pid="$(our_pid)"; then
    log "停止 pid $pid"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  else
    log "没有由本脚本启动的进程"
  fi
  rm -f "$PID_FILE"
}

cmd_status() {
  local pid
  if pid="$(our_pid)" && health_ok; then
    log "运行中：pid ${pid}，${ENDPOINT}（console :${MINIO_CONSOLE_PORT}）"
    if [ -x "$MC_BIN" ]; then
      "${MC[@]}" ls "weave-local/$S3_BUCKET" >/dev/null 2>&1 \
        && log "bucket 可访问：$S3_BUCKET" \
        || log "bucket 不可访问（或未建）：$S3_BUCKET"
    fi
  else
    log "未运行"
    return 3
  fi
}

cmd_logs() {
  [ -f "$LOG_FILE" ] || { err "还没有日志：$LOG_FILE"; exit 1; }
  tail -n "${LINES:-80}" -f "$LOG_FILE"
}

cmd_env() {
  cat <<EOF

本地对象存储已就绪（与 .env 默认值一致，API 无需额外配置）：
  S3_ENDPOINT=$ENDPOINT
  S3_REGION=us-east-1
  S3_BUCKET=$S3_BUCKET
  S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID
  S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY
  S3_FORCE_PATH_STYLE=true
  MEDIA_BASE_URL=$ENDPOINT/$S3_BUCKET
  console: http://127.0.0.1:$MINIO_CONSOLE_PORT

常用：
  pnpm --filter @weave-order/api dev       # 起 API
  scripts/dev-storage-up.sh status|logs|down
EOF
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  env) cmd_env ;;
  *)
    err "未知子命令：$1（可用：up|down|status|logs|env）"
    exit 2
    ;;
esac
