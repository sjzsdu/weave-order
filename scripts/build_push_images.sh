#!/usr/bin/env bash
# 构建并（可选）推送 weave-order 生产镜像到 Docker Hub。
#
# 用法：
#   PUSH=0 ./scripts/build_push_images.sh                 # 只本地构建验证，不推送
#   IMAGE_PREFIX=sjzsdu TAG=<git-sha> ./scripts/build_push_images.sh
#
# 约定（deploy 仓库 AGENTS.md）：镜像一律推自己的 Docker Hub 账号 sjzsdu/*，
# 不在 Docker Hub 与 GHCR 之间切换；tag 用 git sha，可追溯、可回滚。
# 凭据不在这里处理：CI 用 docker/login-action，本地用 docker login。
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE_PREFIX="${IMAGE_PREFIX:-sjzsdu}"
IMAGE_NAME="${IMAGE_NAME:-weave-order}"
TAG="${TAG:-$(git rev-parse --short=12 HEAD)}"
# 移动端 PWA 的 API 基址在构建期固化（Taro defineConstants）
WEAVE_PUBLIC_API_BASE="${WEAVE_PUBLIC_API_BASE:-https://weave-api.wnbgj.com}"
PUSH="${PUSH:-1}"

IMAGE="${IMAGE_PREFIX}/${IMAGE_NAME}:${TAG}"
LATEST="${IMAGE_PREFIX}/${IMAGE_NAME}:latest"

echo "镜像:                 ${IMAGE}"
echo "移动端 API 基址(构建期): ${WEAVE_PUBLIC_API_BASE}"

docker build \
  --build-arg "TARO_APP_API_BASE=${WEAVE_PUBLIC_API_BASE}" \
  -t "${IMAGE}" -t "${LATEST}" .

echo "✅ 构建完成: ${IMAGE}"

if [ "${PUSH}" != "1" ]; then
  echo "PUSH!=1，跳过推送（本地构建验证模式）。"
  exit 0
fi

docker push "${IMAGE}"
docker push "${LATEST}"
echo "✅ 已推送: ${IMAGE} 与 ${LATEST}"
