# 官网镜像：构建期用 WEAVE_* 环境变量决定域名，产物由 nginx 直接托管。
#
#   docker build -f site/Dockerfile \
#     --build-arg WEAVE_SITE_URL=https://weave.wnbgj.com \
#     --build-arg WEAVE_APP_URL=https://app.wnbgj.com \
#     --build-arg WEAVE_ADMIN_URL=https://admin.wnbgj.com \
#     --build-arg WEAVE_SSO_URL=https://sso.wnbgj.com \
#     --build-arg WEAVE_SUPPORT_EMAIL=hello@weaveorder.cn \
#     -t sjzsdu/weave-order-site:dev .
#
# 不传任何参数也能构建，页面沿用 site/site.config.json 里的当前值。

FROM node:22-alpine AS build
WORKDIR /app
COPY site ./site
ARG WEAVE_SITE_URL=
ARG WEAVE_APP_URL=
ARG WEAVE_ADMIN_URL=
ARG WEAVE_SSO_URL=
ARG WEAVE_SUPPORT_EMAIL=
RUN sh site/deploy/configure-env.sh

FROM nginx:1.27-alpine
COPY --from=build /app/site /usr/share/nginx/html
COPY site/deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
