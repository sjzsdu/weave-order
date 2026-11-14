# 官网镜像：域名**在容器启动时**按部署环境写进页面，不在构建期固化。
#
#   docker run -e WEAVE_SITE_URL=https://weave.example.com \
#     -e WEAVE_APP_URL=https://app.example.com \
#     -e WEAVE_ADMIN_URL=https://admin.example.com \
#     -e WEAVE_SSO_URL=https://sso.example.com \
#     -e WEAVE_SUPPORT_EMAIL=hello@example.com \
#     -p 8080:80 sjzsdu/weave-order-site:dev
#
# 为什么不是构建期：同一个镜像要能部署到测试/生产不同域名，构建参数会把镜像
# 和环境绑死，发一次版就要为每个环境单独构建。SEO 需要的绝对地址
# （canonical / og:image / sitemap）在启动时用 site/tools/configure.mjs 重写。
# 变量全不传时沿用镜像里 site/site.config.json 的当前值。
#
# 运行期依赖 node 只用来跑配置与搜索索引脚本，nginx 仍是唯一的服务进程。

FROM nginx:1.27-alpine

# nodejs 仅用于启动时的配置渲染（十几毫秒级，一次），不参与请求处理。
RUN apk add --no-cache nodejs

COPY site /usr/share/nginx/html
COPY site/deploy/nginx.conf /etc/nginx/conf.d/default.conf
# nginx 官方入口会自动执行 /docker-entrypoint.d/*.sh，再启动 nginx。
COPY site/deploy/entrypoint.sh /docker-entrypoint.d/40-weave-site-config.sh
RUN chmod +x /docker-entrypoint.d/40-weave-site-config.sh

EXPOSE 80
