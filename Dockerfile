# weave-order 生产运行镜像（单镜像多进程）。
#
# 设计取舍：整套 monorepo 只构建一个镜像，各服务由 deploy 仓库 compose 的
# `command` 选择进程（pnpm --filter <app> start）。一次构建、一次推送、
# 一个可回滚单元；镜像 tag = 发布 tag（v*）。避免 5 份近似 Dockerfile 与 5 次 CI 构建。
# 代价：镜像包含全部应用代码与 workspace node_modules（约大），试点期用可回滚性换体积，
# 后续如需瘦身再用 pnpm deploy / next standalone 分镜像，不影响部署契约。
#
# 构建期常量只剩 TARO_APP_API_BASE（小程序 / RN 没有注入层时的回落；
# H5 由托管层按部署环境注入 window.__WEAVE_API_BASE__ 覆盖）。
# 官网地址、支持邮箱、各端域名一律运行时由 env_file 注入，不进镜像。
#
# 不安装系统包：lockfile 无 node-gyp 依赖（esbuild/sharp 均带预编译二进制），
# healthcheck 用 Node 内置 fetch，不需要 curl。镜像更小、构建更快、攻击面更小。

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
WORKDIR /app

# 整仓库一次 COPY，不逐项枚举根配置文件。
# 教训：首版只 COPY 了 .npmrc/pnpm-*/package.json/turbo.json，漏掉根 tsconfig.base.json，
# 而全部 13 个包的 tsconfig 都 extends 它 → CI 镜像构建报 TS5083 失败。
# .dockerignore 已排除 node_modules / dist / .next / .git / .env 等，
# 所以这里既不会带进本机产物，也不会覆盖下一步 pnpm install 生成的 node_modules。
COPY . .

RUN pnpm install --frozen-lockfile

ARG TARO_APP_API_BASE=https://weave-api.wnbgj.com
ENV TARO_APP_API_BASE=${TARO_APP_API_BASE}
# NODE_ENV=production 保证移动端 mock 门禁把 mock 代码从产物中摘除
RUN NODE_ENV=production pnpm build

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app /app

# 默认起核心 API；compose 里 web/quote/admin/platform-api/mobile/migrate 各自覆盖 command
CMD ["pnpm", "--filter", "@weave-order/api", "start"]
