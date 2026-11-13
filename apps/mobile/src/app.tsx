import Taro, { useLaunch } from "@tarojs/taro";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { useEffect, useState } from "react";
import { initPwa } from "./lib/pwa";
import { syncQueue } from "./lib/runtime";
import "./app.scss";

/**
 * 移动端根组件。
 *
 * 业务逻辑全部来自 `@weave-order/core` 与 `src/lib`；这里只做 Taro 运行时装配
 * （QueryClient、PWA 引导、离线队列恢复）。
 */
export default function App({ children }: PropsWithChildren) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );

  useLaunch((options) => {
    // 只记录启动来源，不上报敏感参数。
    console.info("[mobile] launch", options.scene);
    initPwa();
    void syncQueue();
  });

  useEffect(() => {
    const handleNetwork = (result: { isConnected: boolean }) => {
      if (result.isConnected) void syncQueue();
    };
    Taro.onNetworkStatusChange(handleNetwork);
    return () => Taro.offNetworkStatusChange(handleNetwork);
  }, []);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
