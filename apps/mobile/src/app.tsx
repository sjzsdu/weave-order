import { Text, View } from "@tarojs/components";
import Taro, { useLaunch } from "@tarojs/taro";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { useEffect, useState } from "react";
import { ensureAuthenticated, getAuthError, isAuthRequired, startLogin } from "./lib/oidc";
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

  // 生产 H5 有 OIDC 配置时，登录完成前不渲染业务页面，避免一堆 401 空态。
  const [authReady, setAuthReady] = useState(!isAuthRequired());
  const [authError, setAuthError] = useState<string | null>(null);

  useLaunch((options) => {
    // 只记录启动来源，不上报敏感参数。
    console.info("[mobile] launch", options.scene);
    void ensureAuthenticated().then((ready) => {
      if (!ready) {
        setAuthError(getAuthError());
        return;
      }
      setAuthReady(true);
      initPwa();
      void syncQueue();
    });
  });

  useEffect(() => {
    if (!authReady) return;
    const handleNetwork = (result: { isConnected: boolean }) => {
      if (result.isConnected) void syncQueue();
    };
    Taro.onNetworkStatusChange(handleNetwork);
    return () => Taro.offNetworkStatusChange(handleNetwork);
  }, [authReady]);

  return (
    <QueryClientProvider client={queryClient}>
      {authReady ? (
        children
      ) : (
        <View style={{ padding: "48px 24px", textAlign: "center" }}>
          <Text>{authError ?? "正在打开统一登录…"}</Text>
          {authError && (
            <View
              style={{ marginTop: "24px", color: "#1f6f5c" }}
              onClick={() => {
                setAuthError(null);
                startLogin();
              }}
            >
              <Text>重新登录</Text>
            </View>
          )}
        </View>
      )}
    </QueryClientProvider>
  );
}
