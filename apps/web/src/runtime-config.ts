"use client";

import { useEffect, useState } from "react";

/**
 * 浏览器侧的部署期配置。
 *
 * 值由 `/config.js`（运行时路由）从容器环境变量读出后挂到 window，
 * 所以同一个镜像换域名只需要重启容器，不需要重新构建。
 * 首帧（SSR 和首次 hydration）读不到时返回空值，调用方据此隐藏入口，
 * 等 `weave:config` 事件到达后再显示，避免服务端/客户端渲染不一致。
 */
export type RuntimeConfig = {
  /** 支持邮箱；未配置时为空字符串。 */
  supportEmail: string;
  /** 官网地址（不带结尾斜杠）；未配置时为空字符串。 */
  marketingUrl: string;
  /** 访问统计配置；provider 为空表示不统计。 */
  analytics: RuntimeAnalytics;
};

/** 统计配置的原始值，交给 src/analytics.ts 解析与校验。 */
export type RuntimeAnalytics = {
  provider: string;
  domain: string;
  host: string;
  key: string;
};

declare global {
  interface Window {
    __WEAVE_CONFIG__?: Partial<RuntimeConfig>;
  }
}

const EMPTY: RuntimeConfig = {
  supportEmail: "",
  marketingUrl: "",
  analytics: { provider: "", domain: "", host: "", key: "" },
};

export function readRuntimeConfig(): RuntimeConfig {
  if (typeof window === "undefined") return EMPTY;
  const value = window.__WEAVE_CONFIG__;
  if (!value) return EMPTY;
  return {
    supportEmail: (value.supportEmail ?? "").trim(),
    marketingUrl: (value.marketingUrl ?? "").trim().replace(/\/+$/, ""),
    analytics: {
      provider: (value.analytics?.provider ?? "").trim(),
      domain: (value.analytics?.domain ?? "").trim(),
      host: (value.analytics?.host ?? "").trim(),
      key: (value.analytics?.key ?? "").trim(),
    },
  };
}

/**
 * 订阅部署期配置。首帧返回空值（SSR 与 hydration 一致），
 * `/config.js` 到达或后续变更时再更新。
 */
export function useRuntimeConfig(): RuntimeConfig {
  const [config, setConfig] = useState<RuntimeConfig>(EMPTY);
  useEffect(() => {
    const sync = () => setConfig(readRuntimeConfig());
    sync();
    window.addEventListener("weave:config", sync);
    return () => window.removeEventListener("weave:config", sync);
  }, []);
  return config;
}
