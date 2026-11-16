"use client";

import { useEffect, useState } from "react";
import { isProductionLikeInBrowser } from "./runtime-mode";

/**
 * 浏览器侧的生产态判定（响应 /config.js 晚到）。
 *
 * 客户端包里的 NODE_ENV 是构建期常量，首帧可能比运行时配置先到；只看一次
 * 会把 staging / e2e 永久判成生产态，或反过来在首帧多发一次 dev 请求。
 * 这里订阅 `weave:config`，配置一到就重新收敛。
 */
export function useProductionLike(): boolean {
  const [productionLike, setProductionLike] = useState(() => isProductionLikeInBrowser());

  useEffect(() => {
    const sync = () => setProductionLike(isProductionLikeInBrowser());
    sync();
    window.addEventListener("weave:config", sync);
    return () => window.removeEventListener("weave:config", sync);
  }, []);

  return productionLike;
}
