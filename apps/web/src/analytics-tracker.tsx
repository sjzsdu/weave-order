"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { applyAnalyticsConfig, trackPageview } from "@/analytics";
import { readRuntimeConfig } from "@/runtime-config";

/**
 * 工作台页面浏览。挂在 ClientRoot 里，一次挂载管全部路由切换。
 *
 * 统计配置和官网地址、客服邮箱一样是**部署期**的：等 `/config.js`（容器环境变量
 * ANALYTICS_*）到达后再注入 provider 脚本。没配置时这里不产生任何网络请求。
 */
export function Analytics() {
  const pathname = usePathname();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const sync = () => setEnabled(applyAnalyticsConfig(readRuntimeConfig().analytics).enabled);
    sync();
    window.addEventListener("weave:config", sync);
    return () => window.removeEventListener("weave:config", sync);
  }, []);

  useEffect(() => {
    if (!enabled || !pathname) return;
    trackPageview();
  }, [enabled, pathname]);

  return null;
}
