/**
 * 租户端 Web 的公网地址（容器运行时由 WEB_APP_URL 注入）。
 *
 * 容器里 request.nextUrl.origin 是内部地址（localhost:3001），任何「跳回本应用」的
 * Location 都不能拿它兜底——否则登录成功、登录失败、登出都会把浏览器带回容器地址。
 *
 * 铁律：
 * - 域名只有一个来源：WEB_APP_URL。代码里不写死任何域名。
 * - 生产环境缺变量直接报错，不静默回退到请求来源地址（静默回退会把线上问题藏起来）。
 * - 开发环境允许回退到请求来源地址，本地 `pnpm dev` 不必额外配置。
 */
export function publicOrigin(fallbackOrigin: string): string {
  const configured = process.env.WEB_APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "生产环境必须配置 WEB_APP_URL（租户端 Web 公网地址），不能回退到请求来源地址",
    );
  }
  return fallbackOrigin.replace(/\/$/, "");
}
