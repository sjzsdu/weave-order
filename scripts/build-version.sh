#!/usr/bin/env bash
# 镜像构建期的版本与 commit 推导（被 scripts/build_push_images.sh source）。
#
# 为什么单独成文件：这条规则决定页脚显示哪个版本，回归一次就是把错的版本发出去，
# 所以它要被 scripts/build-version.test.mjs 在真实 git 仓库里跑一遍。
#
# 规则：只认 HEAD 上的语义化 tag（v0.1.9 / 0.1.9 / v0.1.9-rc.1）。
# 发布必须来自 tag，页脚才可能与实际部署一致；非 tag 构建（main 的 sha、本地 latest）
# 不注入版本，页脚只显示品牌名——宁可不说，也不说错。commit 始终给出，供页脚附注追溯。
# 不用镜像 TAG 变量推导版本：它可以是 latest / sha，也可能被手动覆盖，
# 会给一个未经 tag 确认的提交盖上版本号。
RAW_VERSION="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
APP_VERSION=""
if [[ "${RAW_VERSION}" =~ ^v?([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]]; then
  APP_VERSION="${BASH_REMATCH[1]}" # 去 v 前缀，展示层自己拼 v，避免 vv0.1.8
fi
GIT_COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
