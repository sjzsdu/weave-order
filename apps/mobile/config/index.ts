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
    // NODE_ENV 一并固化，mock 门禁（runtime.ts 的 IS_MOCK）才能在编译期折叠成常量。
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
    "process.env.TARO_APP_MOCK": JSON.stringify(process.env.TARO_APP_MOCK ?? ""),
    "process.env.TARO_APP_API_BASE": JSON.stringify(
      process.env.TARO_APP_API_BASE ?? "http://localhost:3000",
    ),
    // 构建期写入版本号，供「我的 → 设备与关于」展示；没传时显示「开发版」。
    "process.env.TARO_APP_VERSION": JSON.stringify(
      process.env.TARO_APP_VERSION ?? process.env.APP_VERSION ?? "",
    ),
  },
  // PWA 壳：manifest / service worker / icons 直接落到 dist 根目录。
  copy: {
    patterns: process.env.TARO_APP_OUTPUT ? [] : [{ from: "src/pwa", to: outputRoot }],
    options: {},
  },
  framework: "react",
  compiler: {
    type: "webpack5",
    prebundle: { enable: false },
  },
  // Terser 输出选项覆盖。
  //
  // 教训：Taro H5 默认 terser 配置带 output.quote_keys:true（见 @tarojs/webpack5-runner
  // 的 H5BaseConfig.defaultTerserOptions）。Terser 打印 ES 私有类字段时会照做，
  // 把 @tanstack/react-query 的 `#client` / `#mutationId` 等输出成 `#"client"` ——
  // 而 JS 规范里 PrivateIdentifier 只能是 `# IdentifierName`，不能是字符串字面量。
  // 浏览器解析 bundle 时直接抛 SyntaxError: Invalid or unexpected token，
  // 整个 app bundle 解析失败 → 页面永久白屏（首屏 <div id="app"></div> 空白）。
  //
  // 关掉 quote_keys 即可：Terser 默认值本就是 false，Taro 打开它只是为了兼容
  // 老浏览器保留字做键名，本项目 PWA 面向现代浏览器，不需要。
  //
  // 注意：`terser` 是 Taro 的顶层配置项，不在 compiler 里
  // （见 @tarojs/webpack5-runner 的 setMinimizer：它从整个 project config 读 terser）。
  terser: {
    config: {
      output: {
        quote_keys: false,
      },
    },
  },
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
