import type { NextConfig } from "next";
import { QUOTE_BASE_PATH } from "./src/base-path";

/**
 * 客户报价页挂在 /s/[token] 下，与租户端同域但独立应用/独立 Cookie 域。
 * 公开路由不带任何鉴权 Cookie，避免与租户会话串 Cookie。
 *
 * 浏览器侧的 `/api` 反代**不在这里配置**。`rewrites` 的 destination 会在
 * `next build` 时固化进 `routes-manifest.json`，同一镜像跑不同环境时只能有
 * 一个目标且运行时改 env 无效（WAN-210：配错表现为「所有链接都显示链接无效」）。
 * 反代改由 `app/api/[...path]/route.ts` 在每次请求时读 env。
 */
const nextConfig: NextConfig = {
  basePath: QUOTE_BASE_PATH,
  reactStrictMode: true,
  poweredByHeader: false,
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
