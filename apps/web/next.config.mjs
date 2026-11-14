import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * 单一 react-query 实例：`packages/core` 以 CJS dist 进入各 chunk，
 * web 自己的 `providers` 用 ESM 入口，webpack 会各自内联一份模块，
 * 于是 `QueryClientProvider` 和 `useQuery` 拿到两个不同的 context。
 * 这里把所有入口都 alias 到同一个文件，context 才只有一个。
 */
const reactQueryEntry = require.resolve("@tanstack/react-query");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@weave-order/ui", "@weave-order/core", "@weave-order/schema"],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@tanstack/react-query": reactQueryEntry,
    };
    return config;
  },
};

export default nextConfig;
