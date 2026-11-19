import { Text, View } from "@tarojs/components";
import Taro, { useLaunch } from "@tarojs/taro";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ensureAuthenticated, getAuthError } from "./lib/oidc";
import { initPwa } from "./lib/pwa";
import { api, syncQueue } from "./lib/runtime";
import { createStartupNav } from "./lib/startup-nav";
import { needsTenantOnboarding } from "./lib/tenant-onboarding";
import { openStart } from "./routes";
import "./app.scss";

/**
 * 移动端根组件。
 *
 * 业务逻辑全部来自 `@weave-order/core` 与 `src/lib`；这里只做 Taro 运行时装配
 * （QueryClient、PWA 引导、离线队列恢复）与启动门禁的时序协调。
 *
 * 时序要点：children（首屏 Page）始终挂载，加载/错误提示只是覆盖层，不再通过
 * 卸载 children 来显示门禁；创建公司页导航交给 startup-nav 控制器，必须等首屏
 * 挂载完成才执行，且只执行一次，避免 Taro H5「没有找到页面实例」。
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

  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [needsStart, setNeedsStart] = useState(false);

  // 控制器只创建一次；两个信号（首屏挂载 / 需要创建公司）分别由 effect 送入。
  const navRef = useRef<ReturnType<typeof createStartupNav> | null>(null);
  if (navRef.current === null) {
    navRef.current = createStartupNav({ navigateToStart: openStart });
  }
  const nav = navRef.current;

  const bootstrap = useCallback(async () => {
    nav.clearStart();
    setNeedsStart(false);
    setAuthError(null);
    try {
      const ready = await ensureAuthenticated();
      if (!ready) {
        setAuthError(getAuthError() ?? "登录未完成，请重试");
        return;
      }
      const start = await needsTenantOnboarding(() => api.me());
      setAuthReady(true);
      initPwa();
      if (start) {
        setNeedsStart(true);
      } else {
        void syncQueue();
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "启动失败，请重试");
    }
  }, [nav]);

  useLaunch((options) => {
    // 只记录启动来源，不上报敏感参数。
    console.info("[mobile] launch", options.scene);
    void bootstrap();
  });

  // 信号一：首屏 children 挂载完成（effect 在提交后运行，Page 实例已存在）。
  useEffect(() => {
    nav.markPageMounted();
  }, [nav]);

  // 信号二：认证判定完成且需要创建公司时才请求导航；控制器保证只执行一次。
  useEffect(() => {
    if (authReady && needsStart) nav.requestStart();
    else nav.clearStart();
  }, [authReady, needsStart, nav]);

  // 网络恢复后补同步离线队列（仍在启动门禁之下，不影响导航时序）。
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
      {children}
      {!authReady && (
        <View className="auth-gate">
          <View className="auth-gate-card">
            <Text>{authError ?? "正在检查账号与公司空间…"}</Text>
            {authError && (
              <View className="auth-gate-retry" onClick={() => void bootstrap()}>
                <Text>重试</Text>
              </View>
            )}
          </View>
        </View>
      )}
    </QueryClientProvider>
  );
}
