/** @type {import('next').NextConfig} */
const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://localhost:3000";

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@weave-order/ui", "@weave-order/core", "@weave-order/schema"],
  async rewrites() {
    // 浏览器只访问同源 /api，鉴权头由 packages/core 统一附加。
    return [{ source: "/api/:path*", destination: `${apiProxyTarget}/api/:path*` }];
  },
};

export default nextConfig;
