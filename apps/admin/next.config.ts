import type { NextConfig } from "next";

/**
 * 平台总管理端是独立应用（admin.weaveorder.cn），与租户端不同域、不同 Casdoor 应用、
 * 不同 API（控制面 :3002）。浏览器只调同源 /api，由 BFF 注入 httpOnly 令牌。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
