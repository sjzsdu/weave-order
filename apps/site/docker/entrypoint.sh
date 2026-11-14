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

for value in "$site_new" "$app_new" "$admin_new" "$sso_new" "$email_new"; do
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
