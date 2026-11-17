#!/usr/bin/env bash
# 构建并（可选）推送 weave-order 生产镜像到 Docker Hub。
#
# 用法：
#   PUSH=0 ./scripts/build_push_images.sh                      # 只本地构建验证，不推送
#   IMAGE_PREFIX=sjzsdu TAG=v0.1.0 ./scripts/build_push_images.sh
#
# 只发布一个镜像：weave-order。
#   里面装着整套应用：API / Web / Admin / Quote / Mobile / 官网（静态站）。
#   deploy 的 compose 用同一个镜像跑多个服务，靠 command 选择进程。
#
# 踩过的坑（v0.1.3 发布时踩的）：那时官网是单独的镜像 weave-order-site，
# 脚本只 build/push 了主镜像，deploy 的 compose 里官网服务引用的 weave-order-site
# 从来没被构建过 —— 工作流全绿但拉镜像 404，官网起不来。
# 官网并进主镜像后，这类「只发布了一半」在结构上就不可能再发生：
# 官网的产物本来就在主镜像里，不存在「忘了构建另一个镜像」这回事。
#
# 约定（deploy 仓库 AGENTS.md）：镜像一律推自己的 Docker Hub 账号 sjzsdu/*，
# 不在 Docker Hub 与 GHCR 之间切换。
# CI 由推送 v* tag 触发（见 .github/workflows/images.yml），TAG 取 tag 名；
# 手动/本地可用 TAG=<git-sha>。两种 tag 都可追溯、可回滚。
# 每次推送同时移动 :latest；部署侧请用 WEAVE_TAG 锁定具体 tag，不要依赖 latest。
# 凭据不在这里处理：CI 用 docker/login-action，本地用 docker login。
set -euo pipefail
cd "$(dirname "$0")/.."

# 版本与 commit：镜像里没有 .git（.dockerignore 排除），必须在有 git 的这里算好，
# 再经 build-arg 传给 Dockerfile，由 Next 在 pnpm build 时内联进 bundle。
# 优先精确 tag（发版场景得到干净的 v0.1.8）；非 tag 提交得到 v0.1.8-3-g77b6ef4[-dirty]，
# 自带「距上个 tag 几个提交 + 提交号」的可追溯信息。
RAW_VERSION="$(git describe --tags --exact-match HEAD 2>/dev/null || git describe --tags --always --dirty 2>/dev/null || echo "0.0.0")"
APP_VERSION="${RAW_VERSION#v}"                       # 去 v 前缀，前端页脚自己拼 v，避免 vv0.1.8
GIT_COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"

IMAGE_PREFIX="${IMAGE_PREFIX:-sjzsdu}"
IMAGE_NAME="${IMAGE_NAME:-weave-order}"
TAG="${TAG:-$(git rev-parse --short=12 HEAD)}"
# 移动端 PWA 的 API 基址在构建期固化（Taro defineConstants）
WEAVE_PUBLIC_API_BASE="${WEAVE_PUBLIC_API_BASE:-https://weave-api.wnbgj.com}"
PUSH="${PUSH:-1}"

IMAGE="${IMAGE_PREFIX}/${IMAGE_NAME}:${TAG}"
LATEST="${IMAGE_PREFIX}/${IMAGE_NAME}:latest"

echo "镜像:                 ${IMAGE}"
echo "镜像:                 ${LATEST}"
echo "移动端 API 基址(构建期): ${WEAVE_PUBLIC_API_BASE}"
echo "应用版本(构建期):       v${APP_VERSION}"
echo "commit(构建期):         ${GIT_COMMIT}"

docker build \
  --build-arg "TARO_APP_API_BASE=${WEAVE_PUBLIC_API_BASE}" \
  --build-arg "APP_VERSION=${APP_VERSION}" \
  --build-arg "GIT_COMMIT=${GIT_COMMIT}" \
  -t "${IMAGE}" -t "${LATEST}" .

for img in "${IMAGE}" "${LATEST}"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "❌ 本地没有镜像 ${img}，拒绝推送" >&2
    exit 1
  fi
done

echo "✅ 构建完成: ${IMAGE} ${LATEST}"

if [ "${PUSH}" != "1" ]; then
  echo "PUSH!=1，跳过推送（本地构建验证模式）。"
  exit 0
fi

for img in "${IMAGE}" "${LATEST}"; do
  docker push "$img"
done

echo "✅ 已推送: ${IMAGE} ${LATEST}"
