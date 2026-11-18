#!/bin/sh
# 官网静态站的部署期渲染：把镜像里的默认域名换成部署环境的实际地址。
#
# 为什么在启动时改、而不是构建时写死：
#   SEO 需要绝对地址（canonical / OG / sitemap），但域名由部署方决定
#   （deploy 仓库 .env 的 WEAVE_SITE_DOMAIN 等）。启动时渲染一次，
#   同一份镜像就能服务任意域名，改域名不用重新构建、重新发 tag。
#
# 环境变量（与 deploy 仓库 compose 对齐，留空表示沿用镜像内默认值）：
#   WEAVE_SITE_URL       官网地址     → site
#   WEAVE_APP_URL        工作台地址   → app
#   WEAVE_ADMIN_URL      管理端地址   → admin
#   WEAVE_SSO_URL        统一登录地址 → sso
#   WEAVE_SUPPORT_EMAIL  支持邮箱     → email
#   WEAVE_ANALYTICS_PROVIDER  访问统计 provider（plausible / posthog / none）
#   WEAVE_ANALYTICS_DOMAIN    统计站点域名（Plausible 需要）
#   WEAVE_ANALYTICS_HOST      自建统计地址（留空用官方默认）
#   WEAVE_ANALYTICS_KEY       PostHog project key
#   WEAVE_ICP_LICENSE         页脚 ICP 备案号（如「京ICP备2026000000号-1」）
#   WEAVE_PSB_LICENSE         页脚公安联网备案号（如「京公网安备 11010502xxxxxx号」）
#   WEAVE_VERIFY_GOOGLE       Google Search Console 的 HTML 标签验证码
#   WEAVE_VERIFY_BING         Bing Webmaster 的 HTML 标签验证码
#   WEAVE_VERIFY_BAIDU        百度搜索资源平台的 HTML 标签验证码
#
# 渲染方式：先把旧值换成占位符，再把占位符换成新值。
#   两步走是为了避开「新值恰好等于别人的旧值」这种串扰——
#   例如官网换成 weave.wnbgj.com，而工作台的旧值正好是 weave.wnbgj.com，
#   一步替换会把刚写进去的官网地址又替换成工作台地址。
#
# 邮箱先占位：它带域名后缀（hello@weaveorder.cn），
# 不先占位的话域名替换会把邮箱一起改掉。
# 下面的排序是「旧值长度倒序」，邮箱一定比它包含的裸域名长，所以邮箱总是排在域名之前。
set -eu

SITE_DIR="${SITE_DIR:-/usr/share/nginx/html}"
DEFAULTS_FILE="${DEFAULTS_FILE:-/etc/weave-site/defaults.env}"
# 只读的原始产物。渲染是就地改写：容器重启后旧值已经不在文件里，
# 不重铺一遍的话，再换域名就替换不到了。
PRISTINE_DIR="${PRISTINE_DIR:-/opt/weave-site/site}"

log() { echo "[site-render] $*"; }
die() { echo "[site-render] 错误：$*" >&2; exit 1; }

# 每次启动都从原始产物重铺，保证「渲染 → 改域名 → 重启」也能生效。
reset_site_dir() {
  [ -d "$PRISTINE_DIR" ] || return 0
  log "重铺原始产物：${PRISTINE_DIR} → ${SITE_DIR}"
  find "$SITE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -R "$PRISTINE_DIR/." "$SITE_DIR/"
}

# sed 脚本用 | 作分隔符，值里出现 | 会把 s 命令拆坏，直接拒绝而不是写坏页面。
check_value() {
  case "$1" in
    *"|"*) die "值里含有不支持的字符 |：$1" ;;
  esac
  case "$1" in
    *"
"*) die "值里含有换行：$1" ;;
  esac
}

# sed 模式里的元字符转义（替换串另有一套规则）。
esc_pattern() {
  printf '%s' "$1" | sed 's/[][\\.*^$]/\\&/g'
}

# 替换串里 & 是「匹配到的内容」、反斜杠是转义符、分隔符要转义。
esc_replacement() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

# 从 URL 里取主机名（去掉协议与路径）。
host_of() {
  printf '%s' "$1" | sed -e 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||' -e 's|/.*$||'
}

[ -d "$SITE_DIR" ] || die "站点目录不存在：$SITE_DIR"
[ -f "$DEFAULTS_FILE" ] || die "默认配置不存在：$DEFAULTS_FILE"

# 镜像内的默认值（构建期由 apps/site/src/site.config.json 解析而来）
set -a
# shellcheck disable=SC1090
. "$DEFAULTS_FILE"
set +a
for key in SITE APP ADMIN SSO EMAIL; do
  eval "value=\${$key:-}"
  [ -n "$value" ] || die "默认配置缺少 $key：$DEFAULTS_FILE"
done

# 部署环境优先，留空则沿用默认值
site_new="${WEAVE_SITE_URL:-$SITE}"
app_new="${WEAVE_APP_URL:-$APP}"
admin_new="${WEAVE_ADMIN_URL:-$ADMIN}"
sso_new="${WEAVE_SSO_URL:-$SSO}"
email_new="${WEAVE_SUPPORT_EMAIL:-$EMAIL}"

# 统计配置：默认值来自 site.config.json（prepare-config 写进 defaults.env），
# 部署环境用 WEAVE_ANALYTICS_* 覆盖。校验不过就退回 none（页面完全静默），
# 同时在日志里说明，别让运维以为正在统计。
analytics_provider="${WEAVE_ANALYTICS_PROVIDER:-${ANALYTICS_PROVIDER:-none}}"
analytics_domain="${WEAVE_ANALYTICS_DOMAIN:-${ANALYTICS_DOMAIN:-}}"
analytics_host="${WEAVE_ANALYTICS_HOST:-${ANALYTICS_HOST:-}}"
analytics_key="${WEAVE_ANALYTICS_KEY:-${ANALYTICS_KEY:-}}"

# 备案号只在页脚展示，属于纯文本；校验仍然要做，值会进 sed 替换串。
icp_license="${WEAVE_ICP_LICENSE:-}"
psb_license="${WEAVE_PSB_LICENSE:-}"

# 搜索引擎的 HTML 标签验证码只允许 token 字符集；配错时退化为「不输出 meta」，
# 不让坏字符写坏整页。
verify_google="${WEAVE_VERIFY_GOOGLE:-}"
verify_bing="${WEAVE_VERIFY_BING:-}"
verify_baidu="${WEAVE_VERIFY_BAIDU:-}"
for key in google bing baidu; do
  eval "value=\$verify_$key"
  case "$value" in
    "") ;;
    *[!A-Za-z0-9._-]*)
      log "警告：WEAVE_VERIFY_$(printf '%s' "$key" | tr 'a-z' 'A-Z') 含非法字符，本次不输出该验证 meta"
      eval "verify_$key=''"
      ;;
  esac
done

analytics_fallback() {
  log "警告：$1 —— 本次访问统计关闭（provider=none）"
  analytics_provider=none
  analytics_domain=""
  analytics_host=""
  analytics_key=""
}

case "$analytics_provider" in
  "") analytics_provider=none ;;
  none|plausible|posthog) ;;
  *) analytics_fallback "未知的 WEAVE_ANALYTICS_PROVIDER：$analytics_provider" ;;
esac

# 下面三个值会写进页面里的 JSON 字符串：引号、反斜杠、空白、竖线都会写坏文件。
case "$analytics_domain" in
  "") ;;
  *[!A-Za-z0-9.*:_-]*) analytics_fallback "analytics domain 只允许域名：$analytics_domain" ;;
esac
case "$analytics_host" in
  "") ;;
  # 只允许 scheme + 主机 + 端口/路径；dash 的 case 不认方括号里的 & % + @ ~ ?，
  # 这些字符本来也不需要（统计地址不会带查询串）。
  *[!A-Za-z0-9.:/_-]*) analytics_fallback "analytics host 含非法字符：$analytics_host" ;;
  http://localhost*|http://127.0.0.1*) ;;
  https://*) ;;
  *) analytics_fallback "analytics host 必须用 https（本地回环除外）：$analytics_host" ;;
esac
case "$analytics_key" in
  "") ;;
  *[!A-Za-z0-9_-]*) analytics_fallback "analytics key 含非法字符" ;;
esac

for value in "$site_new" "$app_new" "$admin_new" "$sso_new" "$email_new" "$icp_license" "$psb_license"; do
  check_value "$value"
done

reset_site_dir

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

protect="$tmp/protect.sed"
restore="$tmp/restore.sed"
pairs="$tmp/pairs"
: > "$protect"
: > "$restore"
: > "$pairs"

# 旧值 → 占位符 → 新值，一行一条 sed 指令
add_row() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$pairs"
}

add_url_key() {
  old_url="$1"; new_url="$2"; key="$3"
  [ -n "$old_url" ] && [ -n "$new_url" ] || return 0
  [ "$old_url" != "$new_url" ] || return 0
  old_host="$(host_of "$old_url")"
  new_host="$(host_of "$new_url")"
  [ -n "$old_host" ] && [ -n "$new_host" ] || return 0
  check_value "$old_url"; check_value "$new_url"
  check_value "$old_host"; check_value "$new_host"
  add_row "$old_url" "__WEAVE_URL_${key}__" "$new_url"
  add_row "$old_host" "__WEAVE_HOST_${key}__" "$new_host"
}

# 1) 邮箱先占位（见文件头说明）
add_row "$EMAIL" "__WEAVE_EMAIL__" "$email_new"

# 2) 地址与域名
add_url_key "$SITE"  "$site_new"  SITE
add_url_key "$APP"   "$app_new"   APP
add_url_key "$ADMIN" "$admin_new" ADMIN
add_url_key "$SSO"   "$sso_new"   SSO

# 占位符阶段按旧值长度倒序：长串先替，短串后替，避免互相吃掉半截。
#   （同一键的 URL 一定比它的主机名长，所以 URL 总是先于主机名被替换。）
if [ -s "$pairs" ]; then
  awk -F'\t' '{ print length($1) "\t" $0 }' "$pairs" \
    | sort -rn \
    | cut -f2- \
    | while IFS="$(printf '\t')" read -r pattern token replacement; do
        [ -n "$pattern" ] || continue
        printf 's|%s|%s|g\n' "$(esc_pattern "$pattern")" "$token" >> "$protect"
        printf 's|%s|%s|g\n' "$token" "$(esc_replacement "$replacement")" >> "$restore"
      done
fi

render="$tmp/render.sed"
cat "$protect" "$restore" > "$render"

# 3) 落到站点文件上（只处理会被浏览器/爬虫读到的文本类型）
find "$SITE_DIR" -type f \( -name '*.html' -o -name '*.txt' -o -name '*.xml' \) | sort > "$tmp/files"
total=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  sed -f "$render" "$file" > "$file.render.tmp"
  mv "$file.render.tmp" "$file"
  total=$((total + 1))
done < "$tmp/files"

log "官网地址 → ${site_new}"
log "工作台   → ${app_new}"
log "管理端   → ${admin_new}"
log "统一登录 → ${sso_new}"
log "支持邮箱 → ${email_new}"
log "已渲染 ${total} 个静态文件"

# 3.5) 运行期渲染：访问统计、备案号、搜索引擎验证 meta。
#      用占位符而不是「旧值→新值」：provider 的值很短（none）又是常见词，
#      直接做全局替换会误伤正文。
html_render="$tmp/html.sed"
: > "$html_render"
for pair in \
  "__WEAVE_ANALYTICS_PROVIDER__|${analytics_provider}" \
  "__WEAVE_ANALYTICS_DOMAIN__|${analytics_domain}" \
  "__WEAVE_ANALYTICS_HOST__|${analytics_host}" \
  "__WEAVE_ANALYTICS_KEY__|${analytics_key}"
do
  token="${pair%%|*}"
  value="${pair#*|}"
  printf 's|%s|%s|g\n' "$token" "$(esc_replacement "$value")" >> "$html_render"
done

# 备案号：值始终替换（未配置时换成空串），配了才去掉 hidden。
printf 's|__WEAVE_ICP_LICENSE__|%s|g\n' "$(esc_replacement "$icp_license")" >> "$html_render"
printf 's|__WEAVE_PSB_LICENSE__|%s|g\n' "$(esc_replacement "$psb_license")" >> "$html_render"
[ -z "$icp_license" ] || printf 's|<a hidden data-weave-icp|<a data-weave-icp|g\n' >> "$html_render"
[ -z "$psb_license" ] || printf 's|<span hidden data-weave-psb|<span data-weave-psb|g\n' >> "$html_render"

# 验证 meta：未配置就把 content 换成空串（不能按行删除——Astro 压缩后整个
# head 可能是一行，删行会把 canonical / OG 一起删掉），配了才替换 token。
for pair in \
  "__WEAVE_VERIFY_GOOGLE__|${verify_google}" \
  "__WEAVE_VERIFY_BING__|${verify_bing}" \
  "__WEAVE_VERIFY_BAIDU__|${verify_baidu}"
do
  token="${pair%%|*}"
  value="${pair#*|}"
  printf 's|%s|%s|g\n' "$token" "$(esc_replacement "$value")" >> "$html_render"
done

find "$SITE_DIR" -type f -name '*.html' | sort > "$tmp/html"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  sed -f "$html_render" "$file" > "$file.runtime.tmp"
  mv "$file.runtime.tmp" "$file"
done < "$tmp/html"
log "访问统计 → provider=${analytics_provider} domain=${analytics_domain:-<空>} host=${analytics_host:-<默认>}"
if [ -n "$icp_license" ] || [ -n "$psb_license" ]; then
  log "备案号   → ICP=${icp_license:-<空>} 公安=${psb_license:-<空>}"
else
  log "备案号   → 未配置（页脚不展示）"
fi
log "搜索验证 → Google=${verify_google:+已配置} Bing=${verify_bing:+已配置} 百度=${verify_baidu:+已配置}"

# 4) 残留检查：新值里本来就含旧串的情况跳过，只提醒真正没替换掉的硬编码域名。
all_new="$site_new $app_new $admin_new $sso_new $email_new"
for old in "$SITE" "$APP" "$ADMIN" "$SSO"; do
  old_host="$(host_of "$old")"
  [ -n "$old_host" ] || continue
  case "$all_new" in
    *"$old_host"*) continue ;;
  esac
  left="$(grep -r -o -F "$old_host" "$SITE_DIR" 2>/dev/null | wc -l | tr -d ' ')"
  [ "$left" = "0" ] || log "提醒：${old_host} 在站点里还剩 ${left} 处（可能是非 html/txt/xml 文件里的硬编码）"
done
