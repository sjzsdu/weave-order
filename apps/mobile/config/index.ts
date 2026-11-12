import { defineConfig } from "@tarojs/cli";

const outputRoot = process.env.TARO_APP_OUTPUT ?? "dist";
/**
 * Taro 统一构建配置。
 *
 * P0 只启用 H5/PWA；小程序/RN 是同一份源码的额外输出（P3），
 * 因此页面与组件里禁止为某个端复制一份实现，只用 process.env.TARO_ENV 做薄分支。
 */
export default defineConfig({
  projectName: "weave-order-mobile",
  date: "2026-11-12",
  designWidth: 750,
  deviceRatio: { 640: 2.34 / 2, 750: 1, 828: 1.81 / 2 },
  sourceRoot: "src",
  outputRoot,
  plugins: [],
  defineConstants: {
    // 环境变量在构建期固化；页面里只读 process.env.TARO_APP_*。
    "process.env.TARO_APP_MOCK": JSON.stringify(process.env.TARO_APP_MOCK ?? ""),
    "process.env.TARO_APP_API_BASE": JSON.stringify(
      process.env.TARO_APP_API_BASE ?? "http://localhost:3000",
    ),
  },
  // PWA 壳：manifest / service worker / icons 直接落到 dist 根目录。
  copy: {
    patterns: process.env.TARO_APP_OUTPUT ? [] : [{ from: "src/pwa", to: outputRoot }],
    options: {},
  },
  framework: "react",
  compiler: { type: "webpack5", prebundle: { enable: false } },
  cache: { enable: false },
  // 共享包走 pnpm workspace 的 node_modules 解析（构建产物 dist），
  // 不用 alias 指向 src，避免 Taro 对绝对/相对路径做二次拼接。
  mini: {
    postcss: {
      pxtransform: { enable: true, config: {} },
      cssModules: { enable: false },
    },
  },
  h5: {
    publicPath: "/",
    staticDirectory: "static",
    output: { filename: "js/[name].[hash:8].js", chunkFilename: "js/[name].[chunkhash:8].js" },
    miniCssExtractPluginOption: { filename: "css/[name].[hash:8].css" },
    postcss: {
      autoprefixer: { enable: true, config: {} },
      cssModules: { enable: false },
    },
  },
  rn: { appName: "weaveOrder" },
});
