import Taro, { useLaunch } from "@tarojs/taro";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { useState } from "react";
import "./app.scss";

/**
 * 移动端根组件。
 *
 * 业务逻辑全部来自 `@weave-order/core`；这里只做 Taro 运行时装配
 * （QueryClient、启动参数、离线队列恢复）。
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
    // 只记录启动来源，不上报敏感参数；后续接 Plausible。
    console.info("[mobile] launch", options.scene);
    void Taro.setNavigationBarTitle({ title: "织序 · 今日" });
  });

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
