"use client";

import {
  QueryClientProvider,
  createApiClient,
  createMockApiClient,
  createQueryClient,
} from "@weave-order/core";
import type { ApiClient } from "@weave-order/core";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { isProductionLikeInBrowser } from "@/runtime-mode";

const DEMO_STORAGE_KEY = "weave.demo";
const ApiContext = createContext<ApiClient | null>(null);

/** 页面永远从这里拿 client；不在组件里裸 fetch，也不碰 tenant_id。 */
export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error("useApi 必须在 AppProviders 内使用");
  return client;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [demo, setDemo] = useState(() => {
    // 生产态（含 staging 的 NODE_ENV=development + AUTH_MODE=oidc）不提供 mock 数据。
    if (isProductionLikeInBrowser()) return false;
    if (typeof window === "undefined") return process.env.NEXT_PUBLIC_DEMO_MODE === "1";
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") === "1") return true;
    if (params.get("demo") === "0") return false;
    return (
      process.env.NEXT_PUBLIC_DEMO_MODE === "1" ||
      window.localStorage.getItem(DEMO_STORAGE_KEY) === "1"
    );
  });
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (isProductionLikeInBrowser()) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") === "1") {
      window.localStorage.setItem(DEMO_STORAGE_KEY, "1");
      document.cookie = "weave_demo=1; path=/; max-age=86400; samesite=lax";
      setDemo(true);
    } else if (params.get("demo") === "0") {
      window.localStorage.removeItem(DEMO_STORAGE_KEY);
      document.cookie = "weave_demo=; path=/; max-age=0; samesite=lax";
      setDemo(false);
    } else if (window.localStorage.getItem(DEMO_STORAGE_KEY) === "1") {
      setDemo(true);
    }
  }, []);

  /*
   * `/config.js` 是运行时下发的，可能比首帧晚到。判定一变就重新收敛：
   * 一旦确认是生产态，立即退出演示模式，不再用 mock client 发请求。
   */
  useEffect(() => {
    const sync = () => {
      if (isProductionLikeInBrowser()) setDemo(false);
    };
    sync();
    window.addEventListener("weave:config", sync);
    return () => window.removeEventListener("weave:config", sync);
  }, []);

  // 所有 hooks 必须在下面的 mounted 早退之前调用，否则首帧与后续帧的 hook 数量
  // 不一致，React 会抛「Rendered more hooks than during the previous render」。
  const client = useMemo<ApiClient>(() => {
    if (demo) return createMockApiClient();
    // token 只在服务端 BFF（app/api/[...path]/route.ts）注入，浏览器不持有。
    return createApiClient({ baseUrl: "", getToken: () => null });
  }, [demo]);

  const queryClient = useMemo(() => createQueryClient(), []);

  /*
   * 桌面工作区是纯客户端应用：服务端不跑 react-query hooks。
   * 这样也避免 Next 服务端打包与 packages/core 各自解析一份 QueryClient context。
   */
  if (!mounted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper text-sm text-ink-400">
        正在连接织序…
      </div>
    );
  }

  return (
    <ApiContext.Provider value={client}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ApiContext.Provider>
  );
}
