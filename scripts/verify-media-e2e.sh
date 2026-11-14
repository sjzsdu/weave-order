#!/usr/bin/env bash
#
# verify-media-e2e.sh — S1 验收 1 的可重复真机验证：
#   POST /api/media/presign → curl PUT 直传 → POST /api/media/confirm
#   → GET /api/samples/:id 返回 images 至少一条（且该 URL 真能匿名取到图）
#
# 前置：
#   1. scripts/dev-storage-up.sh        # 本地对象存储就绪（或等价的 MinIO/COS）
#   2. pnpm db:migrate && pnpm seed     # 库与样品种子
#   3. pnpm --filter @weave-order/api dev   # API 起来（默认 3000）
#
# 用法：
#   scripts/verify-media-e2e.sh
#   API_BASE=http://127.0.0.1:3010 AUTH="dev:demo:demo" SAMPLE_ID=<uuid> scripts/verify-media-e2e.sh
#
# 退出码：0 全链路通过；1 任一步失败（失败步骤与响应体打印在 stderr）。

set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:3000}"
AUTH="${AUTH:-dev:demo:demo}"
SAMPLE_ID="${SAMPLE_ID:-}"
MIME="${MIME:-image/png}"
WORKDIR="${WORKDIR:-$(mktemp -d)}"
IMAGE_FILE="${IMAGE_FILE:-$WORKDIR/acceptance.png}"

step() { printf '\n== %s\n' "$*"; }
die() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

json_get() {
  # json_get '<json>' '<dot.path>'；路径只支持对象/数组下标，够本脚本用。
  node -e '
    const [raw, path] = process.argv.slice(1);
    let cur = JSON.parse(raw);
    for (const part of path.split(".")) {
      if (cur == null) break;
      cur = cur[part];
    }
    if (cur == null) process.exit(1);
    process.stdout.write(typeof cur === "string" ? cur : JSON.stringify(cur));
  ' "$1" "$2"
}

http() {
  # http <method> <url> [curl args...]；输出 body，HTTP 码写到 $WORKDIR/code。
  local method="$1" url="$2"; shift 2
  curl -sS --max-time 30 -X "$method" -o "$WORKDIR/body" -w '%{http_code}' "$@" "$url" \
    >"$WORKDIR/code"
}

assert_code() {
  # 允许传多个可接受状态码：Nest 默认 POST 返回 201。
  local what="$1"; shift
  code="$(cat "$WORKDIR/code")"
  local ok=0 expected
  for expected in "$@"; do [ "$code" = "$expected" ] && ok=1; done
  if [ "$ok" != "1" ]; then
    printf '  %s → HTTP %s（预期 %s）\n' "$what" "$code" "$*" >&2
    cat "$WORKDIR/body" >&2; echo >&2
    die "$what 失败"
  fi
  printf '  %s → HTTP %s\n' "$what" "$code"
}

mkdir -p "$WORKDIR"
if [ ! -f "$IMAGE_FILE" ]; then
  # 1x1 透明 PNG；presign 只校验 mime/体积，confirm 只校验 HEAD 元信息，够用。
  printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' \
    | base64 -d >"$IMAGE_FILE"
fi
BYTE_SIZE="$(wc -c <"$IMAGE_FILE" | tr -d ' ')"

step "0. 前置检查 /api/health"
http GET "$API_BASE/api/health" || die "API 不可达：$API_BASE"
assert_code "GET /api/health" 200

AUTH_HEADER="Authorization: Bearer $AUTH"

if [ -z "$SAMPLE_ID" ]; then
  step "1. 取一个样品（GET /api/samples）"
  http GET "$API_BASE/api/samples?limit=1" -H "$AUTH_HEADER"
  assert_code "GET /api/samples" 200
  SAMPLE_ID="$(json_get "$(cat "$WORKDIR/body")" 'samples.0.id')" || die "没有可用样品，先跑 pnpm seed 或传 SAMPLE_ID"
  printf '  sampleId=%s\n' "$SAMPLE_ID"
fi

step "2. 上传前：GET /api/samples/$SAMPLE_ID"
http GET "$API_BASE/api/samples/$SAMPLE_ID" -H "$AUTH_HEADER"
assert_code "GET /api/samples/:id" 200
BEFORE_BODY="$(cat "$WORKDIR/body")"
BEFORE_IMAGES="$(json_get "$BEFORE_BODY" 'sample.images.length')"
printf '  images 数量=%s\n' "$BEFORE_IMAGES"

step "3. POST /api/media/presign"
PRESIGN_PAYLOAD="$(node -e 'process.stdout.write(JSON.stringify({mimeType:process.argv[1],byteSize:Number(process.argv[2]),sampleId:process.argv[3]}))' "$MIME" "$BYTE_SIZE" "$SAMPLE_ID")"
http POST "$API_BASE/api/media/presign" \
  -H "$AUTH_HEADER" -H 'Content-Type: application/json' \
  --data "$PRESIGN_PAYLOAD"
assert_code "POST /api/media/presign" 200 201
PRESIGN_BODY="$(cat "$WORKDIR/body")"
UPLOAD_URL="$(json_get "$PRESIGN_BODY" 'uploadUrl')" || die "presign 响应缺 uploadUrl"
OBJECT_KEY="$(json_get "$PRESIGN_BODY" 'objectKey')" || die "presign 响应缺 objectKey"
printf '  objectKey=%s\n  uploadUrl=%.96s…\n' "$OBJECT_KEY" "$UPLOAD_URL"

step "4. curl -X PUT 直传对象存储（不带 Authorization）"
http PUT "$UPLOAD_URL" -H "Content-Type: $MIME" --data-binary "@$IMAGE_FILE"
assert_code "PUT uploadUrl" 200

step "5. POST /api/media/confirm"
# 可重复执行：已有主图时不再抢主图（数据库对每样品最多一张主图有部分唯一索引）。
CONFIRM_PAYLOAD="$(node -e '
  const sample = JSON.parse(process.argv[1]).sample;
  const hasPrimary = (sample.images ?? []).some((image) => image.isPrimary);
  const body = { objectKey: process.argv[2] };
  if (!hasPrimary) body.isPrimary = true;
  process.stdout.write(JSON.stringify(body));
' "$BEFORE_BODY" "$OBJECT_KEY")"
http POST "$API_BASE/api/media/confirm" \
  -H "$AUTH_HEADER" -H 'Content-Type: application/json' \
  --data "$CONFIRM_PAYLOAD"
assert_code "POST /api/media/confirm" 200 201
CONFIRM_BODY="$(cat "$WORKDIR/body")"
IMAGE_ID="$(json_get "$CONFIRM_BODY" 'image.id')" || die "confirm 响应缺 image.id"
printf '  imageId=%s\n' "$IMAGE_ID"

step "6. GET /api/samples/$SAMPLE_ID 复核"
http GET "$API_BASE/api/samples/$SAMPLE_ID" -H "$AUTH_HEADER"
assert_code "GET /api/samples/:id" 200
AFTER_BODY="$(cat "$WORKDIR/body")"
AFTER_IMAGES="$(json_get "$AFTER_BODY" 'sample.images.length')"
[ "$AFTER_IMAGES" -ge 1 ] || { cat "$WORKDIR/body" >&2; die "images 仍为空"; }
IMAGE_URL="$(json_get "$AFTER_BODY" 'sample.images.0.url')" || die "images[0] 缺 url"
printf '  images 数量=%s（上传前 %s）\n  images[0].url=%s\n' "$AFTER_IMAGES" "$BEFORE_IMAGES" "$IMAGE_URL"

step "7. 公开读复核：GET images[0].url"
http GET "$IMAGE_URL"
assert_code "GET images[0].url" 200
printf '  返回字节数=%s（本地文件 %s）\n' "$(wc -c <"$WORKDIR/body" | tr -d ' ')" "$BYTE_SIZE"

step "8. 契约复核：DB 只存 object_key，URL 由 MEDIA_BASE_URL / 签名动态拼出"
printf '  objectKey=%s\n' "$OBJECT_KEY"

printf '\nPASS: presign → PUT → confirm → GET /api/samples/%s（images=%s）全链路通过\n' "$SAMPLE_ID" "$AFTER_IMAGES"
