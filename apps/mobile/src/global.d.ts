/// <reference types="@tarojs/taro" />

declare namespace NodeJS {
  interface ProcessEnv {
    readonly TARO_ENV: "weapp" | "h5" | "rn" | "swan" | "alipay" | "tt" | "qq" | "jd";
    readonly TARO_APP_API_BASE?: string;
  }
}
