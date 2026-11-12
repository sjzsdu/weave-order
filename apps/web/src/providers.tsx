"use client";

import { QueryClientProvider, createApiClient, createMockApiClient, createQueryClient } from "@weave-order/core";
import type { ApiClient } from "@weave-order/core";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

const DEMO_STORAGE_KEY = "weave.demo";
const ApiContext = createContext<ApiClient | null>(null);

/** 页面永远从这里拿 client；不在组件里裸 fetch，也不碰 tenant_id。 */
export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error("useApi 必须在 AppProviders 内使用");
  return client;
}

const DEMO_ALLOWED = process.env.NODE_ENV !== "production";

export function AppProviders({ children }: { children: ReactNode }) {
  const [demo, setDemo] = useState(() => {
    if (!DEMO_ALLOWED) return false;
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
    if (!DEMO_ALLOWED) return;
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

  const client = useMemo<ApiClient>(() => {
    if (demo) return createMockApiClient();
    // token 只在服务端 BFF（app/api/[...path]/route.ts）注入，浏览器不持有。
    return createApiClient({ baseUrl: "", getToken: () => null });
  }, [demo]);

  const queryClient = useMemo(() => createQueryClient(), []);

  return (
    <ApiContext.Provider value={client}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ApiContext.Provider>
  );
}
