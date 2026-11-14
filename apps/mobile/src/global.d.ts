/// <reference types="@tarojs/taro" />

declare namespace NodeJS {
  interface ProcessEnv {
    readonly TARO_ENV: "weapp" | "h5" | "rn" | "swan" | "alipay" | "tt" | "qq" | "jd";
    readonly TARO_APP_API_BASE?: string;
  }
}

/**
 * H5 托管层在 index.html 里注入的部署期 API 基址
 * （见 scripts/serve-static.mjs 的 WEAVE_API_BASE）。小程序 / RN 没有 window。
 */
interface Window {
  __WEAVE_API_BASE__?: string;
}
