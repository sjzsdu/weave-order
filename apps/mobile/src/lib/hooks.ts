import { useEffect, useState } from "react";
import Taro from "@tarojs/taro";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@weave-order/core";
import type { ApprovalQueue, Customer, PanoramaSnapshot } from "@weave-order/schema";
import { api, offlineQueue, syncQueue } from "./runtime";
import { readCache, writeCache } from "./cache";
import { onQueueChanged } from "./offline";

/** 网络状态：弱网 / 断网时页面显示「已存本地」。 */
export function useNetworkStatus(): { online: boolean; networkType: string } {
  const [state, setState] = useState<{ online: boolean; networkType: string }>({
    online: true,
    networkType: "unknown",
  });

  useEffect(() => {
    void Taro.getNetworkType()
      .then((result) =>
        setState({ online: result.networkType !== "none", networkType: result.networkType }),
      )
      .catch(() => undefined);
    const handler = (result: { isConnected: boolean; networkType: string }) => {
      setState({ online: result.isConnected, networkType: result.networkType });
      if (result.isConnected) void syncQueue();
    };
    Taro.onNetworkStatusChange(handler);
    return () => Taro.offNetworkStatusChange(handler);
  }, []);

  return state;
}

export function useApprovals() {
  const cached = readCache<ApprovalQueue>("approvals");
  return useQuery({
    queryKey: queryKeys.approvals,
    queryFn: async () => {
      const data = await api.approvals();
      writeCache("approvals", data);
      return data;
    },
    ...(cached
      ? { initialData: cached.data, initialDataUpdatedAt: Date.parse(cached.savedAt) }
      : {}),
    staleTime: 15_000,
  });
}

/** 审批队列（游标分页）：审批页用「加载更多」逐步取，不再一次只看首页。 */
export function useApprovalQueue(pageSize = 30) {
  const queue = useInfiniteQuery({
    queryKey: queryKeys.approvalQueue(pageSize),
    queryFn: ({ pageParam }) => api.approvals({ cursor: pageParam, limit: pageSize }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
  });
  const items = queue.data?.pages.flatMap((page) => page.items) ?? [];
  return { ...queue, items, hasMore: queue.hasNextPage };
}

export function useCustomers(limit = 50) {
  const cached = readCache<Customer[]>(`customers.${limit}`);
  return useQuery({
    queryKey: queryKeys.customers(limit),
    queryFn: async () => {
      const data = await api.listCustomers(limit);
      writeCache(`customers.${limit}`, data);
      return data;
    },
    ...(cached
      ? { initialData: cached.data, initialDataUpdatedAt: Date.parse(cached.savedAt) }
      : {}),
    staleTime: 60_000,
  });
}

export function usePanorama() {
  const cached = readCache<PanoramaSnapshot>("panorama");
  return useQuery({
    queryKey: queryKeys.panorama,
    queryFn: async () => {
      const data = await api.panorama();
      writeCache("panorama", data);
      return data;
    },
    ...(cached
      ? { initialData: cached.data, initialDataUpdatedAt: Date.parse(cached.savedAt) }
      : {}),
    staleTime: 30_000,
  });
}

export function useAudit(limit = 8) {
  return useQuery({
    queryKey: queryKeys.audit(limit),
    queryFn: async () => {
      const entries = await api.audit(limit);
      writeCache(`audit.${limit}`, entries);
      return entries;
    },
    staleTime: 30_000,
  });
}

export interface QueueState {
  total: number;
  pending: number;
  conflicts: number;
  updatedAt: number;
}

/** 离线队列计数；任何入队 / 提交后自动刷新。 */
export function useQueueState(): QueueState {
  const [state, setState] = useState<QueueState>({
    total: 0,
    pending: 0,
    conflicts: 0,
    updatedAt: 0,
  });

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const items = await offlineQueue.list();
      if (cancelled) return;
      setState({
        total: items.length,
        pending: items.filter((item) => item.status === "pending").length,
        conflicts: items.filter((item) => item.status === "conflict").length,
        updatedAt: Date.now(),
      });
    };
    void refresh();
    const off = onQueueChanged(() => void refresh());
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return state;
}

/** 提交离线队列并刷新受影响的查询。 */
export function useSyncQueue() {
  const queryClient = useQueryClient();
  return async () => {
    const result = await syncQueue();
    if (result.sent > 0) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals }),
        queryClient.invalidateQueries({ queryKey: queryKeys.panorama }),
        queryClient.invalidateQueries({ queryKey: queryKeys.audit(8) }),
      ]);
    }
    return result;
  };
}

export function useOfflineBanner(): { show: boolean; text: string } {
  const network = useNetworkStatus();
  const queue = useQueueState();
  if (!network.online) {
    return {
      show: true,
      text:
        queue.pending > 0
          ? `已离线 · ${queue.pending} 条已存本地，联网后自动提交`
          : "已离线 · 当前操作会先存本地",
    };
  }
  if (queue.conflicts > 0)
    return { show: true, text: `${queue.conflicts} 条离线操作与服务端版本冲突，去「更多」确认` };
  return { show: false, text: "" };
}
