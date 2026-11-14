/**
 * 平台总管理端的公网地址（容器运行时由 PLATFORM_PUBLIC_URL 注入）。
 *
 * 与租户端同一套约定：
 * - 域名只有一个来源：PLATFORM_PUBLIC_URL。代码里不写死任何域名。
 * - 生产环境缺变量直接报错，不静默回退到请求来源地址（容器内即 localhost:3003）。
 * - 开发环境允许回退到请求来源地址，本地 `pnpm dev` 不必额外配置。
 */
export function publicOrigin(fallbackOrigin: string): string {
  const configured = process.env.PLATFORM_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "生产环境必须配置 PLATFORM_PUBLIC_URL（平台总管理端公网地址），不能回退到请求来源地址",
    );
  }
  return fallbackOrigin.replace(/\/$/, "");
}
