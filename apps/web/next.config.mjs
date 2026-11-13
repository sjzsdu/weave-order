/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@weave-order/ui", "@weave-order/core", "@weave-order/schema"],
};

export default nextConfig;
