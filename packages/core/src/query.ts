import { QueryClient } from "@tanstack/react-query";

export { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * 前端统一的 QueryClient 工厂。
 * Provider 必须从本包导出：各端只装一份 react-query，避免同一页面出现两个 context。
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: false },
    },
  });
}
