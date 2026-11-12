import type { NextConfig } from "next";

/**
 * 客户报价页挂在 /s/[token] 下，与租户端同域但独立应用/独立 Cookie 域。
 * 公开路由不带任何鉴权 Cookie，避免与租户会话串 Cookie。
 */
const nextConfig: NextConfig = {
  basePath: "/s",
  reactStrictMode: true,
  poweredByHeader: false,
  /**
   * 浏览器默认走同源 `/api`（不带 basePath），由 Next 反代到后端：
   * 生产不需要为公开页单独开 CORS，本地 `next start` 也能直接点接受/提问。
   */
  async rewrites() {
    const api = process.env.QUOTE_API_BASE_URL ?? "http://localhost:3000";
    return [{ source: "/api/:path*", destination: `${api}/api/:path*`, basePath: false }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
