import { Text, View } from "@tarojs/components";
import Taro, { useLaunch } from "@tarojs/taro";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { useCallback, useEffect, useState } from "react";
import { ensureAuthenticated, getAuthError } from "./lib/oidc";
import { initPwa } from "./lib/pwa";
import { api, syncQueue } from "./lib/runtime";
import { needsTenantOnboarding } from "./lib/tenant-onboarding";
import { openStart } from "./lib/nav";
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

  // 登录和公司门禁完成前不渲染业务页面，避免未登录或无公司时出现空态。
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const bootstrap = useCallback(async () => {
    setAuthReady(false);
    setAuthError(null);
    try {
      const ready = await ensureAuthenticated();
      if (!ready) {
        setAuthError(getAuthError());
        return;
      }
      const needsStart = await needsTenantOnboarding(() => api.me());
      setAuthReady(true);
      initPwa();
      if (needsStart) {
        openStart();
      } else {
        void syncQueue();
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "启动失败，请重试");
    }
  }, []);

  useLaunch((options) => {
    // 只记录启动来源，不上报敏感参数。
    console.info("[mobile] launch", options.scene);
    void bootstrap();
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
          <Text>{authError ?? "正在检查账号与公司空间…"}</Text>
          {authError && (
            <View style={{ marginTop: "24px", color: "#1f6f5c" }} onClick={() => void bootstrap()}>
              <Text>重试</Text>
            </View>
          )}
        </View>
      )}
    </QueryClientProvider>
  );
}
