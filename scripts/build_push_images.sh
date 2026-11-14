#!/usr/bin/env bash
# 构建并（可选）推送 weave-order 生产镜像到 Docker Hub。
#
# 用法：
#   PUSH=0 ./scripts/build_push_images.sh                 # 只本地构建验证，不推送
#   IMAGE_PREFIX=sjzsdu TAG=v0.1.0 ./scripts/build_push_images.sh
#
# 约定（deploy 仓库 AGENTS.md）：镜像一律推自己的 Docker Hub 账号 sjzsdu/*，
# 不在 Docker Hub 与 GHCR 之间切换。
# CI 由推送 v* tag 触发（见 .github/workflows/images.yml），TAG 取 tag 名；
# 手动/本地可用 TAG=<git-sha>。两种 tag 都可追溯、可回滚。
# 每次推送同时移动 :latest；部署侧请用 WEAVE_TAG 锁定具体 tag，不要依赖 latest。
# 凭据不在这里处理：CI 用 docker/login-action，本地用 docker login。
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE_PREFIX="${IMAGE_PREFIX:-sjzsdu}"
IMAGE_NAME="${IMAGE_NAME:-weave-order}"
TAG="${TAG:-$(git rev-parse --short=12 HEAD)}"
# 移动端 PWA 的 API 基址在构建期固化（Taro defineConstants）
WEAVE_PUBLIC_API_BASE="${WEAVE_PUBLIC_API_BASE:-https://weave-api.wnbgj.com}"
# 登录页「返回官网 / 帮助中心」的官网地址（NEXT_PUBLIC_* 编译期内联）
WEAVE_MARKETING_URL="${WEAVE_MARKETING_URL:-https://weaveorder.cn}"
PUSH="${PUSH:-1}"

IMAGE="${IMAGE_PREFIX}/${IMAGE_NAME}:${TAG}"
LATEST="${IMAGE_PREFIX}/${IMAGE_NAME}:latest"

echo "镜像:                 ${IMAGE}"
echo "移动端 API 基址(构建期): ${WEAVE_PUBLIC_API_BASE}"
echo "官网地址(构建期):        ${WEAVE_MARKETING_URL}"

docker build \
  --build-arg "TARO_APP_API_BASE=${WEAVE_PUBLIC_API_BASE}" \
  --build-arg "NEXT_PUBLIC_MARKETING_URL=${WEAVE_MARKETING_URL}" \
  -t "${IMAGE}" -t "${LATEST}" .

echo "✅ 构建完成: ${IMAGE}"

if [ "${PUSH}" != "1" ]; then
  echo "PUSH!=1，跳过推送（本地构建验证模式）。"
  exit 0
fi

docker push "${IMAGE}"
docker push "${LATEST}"
echo "✅ 已推送: ${IMAGE} 与 ${LATEST}"
