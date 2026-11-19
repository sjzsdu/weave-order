import { useEffect, useState } from "react";
import Taro from "@tarojs/taro";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@weave-order/core";
import type {
  ApprovalQueue,
  Capability,
  Customer,
  Customer360,
  CustomerListItem,
  CustomerTimelinePage,
  PanoramaSnapshot,
} from "@weave-order/schema";
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

/**
 * 当前身份的能力清单（服务端按 capabilities.ts 算好）。
 * 只用于显隐入口，真正的拦截永远在服务端；拿不到时按「全部隐藏」处理。
 */
export function useCapabilities(): {
  capabilities: Capability[];
  has: (capability: Capability) => boolean;
} {
  const { data } = useQuery({
    queryKey: ["me", "capabilities"],
    queryFn: () => api.me(),
    staleTime: 300_000,
  });
  const capabilities = data && "capabilities" in data ? data.capabilities : [];
  return {
    capabilities,
    has: (capability) => capabilities.includes(capability),
  };
}

/**
 * 客户列表（带聚合数字）：排序交给服务端，页面拿到什么顺序就显示什么顺序。
 * `followup` = 待跟进优先（未决报价 / 逾期应收）→ 最近往来倒序 → 等级。
 */
export function useCustomerList(sort: "recent" | "followup" = "followup", limit = 100) {
  const cacheKey = `customerList.${sort}.${limit}`;
  const cached = readCache<CustomerListItem[]>(cacheKey);
  return useQuery({
    queryKey: queryKeys.customerList({ sort, limit }),
    queryFn: async () => {
      const data = await api.customerList({ sort, limit });
      writeCache(cacheKey, data);
      return data;
    },
    ...(cached
      ? { initialData: cached.data, initialDataUpdatedAt: Date.parse(cached.savedAt) }
      : {}),
    staleTime: 60_000,
  });
}

/**
 * 客户 360：与 PC 端读同一个聚合接口，数字不再由前端用列表/全景自己拼。
 * 缓存按客户 id 分开，弱网回来先给上次的快照。
 */
export function useCustomer360(customerId: string) {
  const cached = readCache<Customer360>(`customer360.${customerId}`);
  return useQuery({
    queryKey: queryKeys.customer360(customerId),
    queryFn: async () => {
      const data = await api.customer360(customerId);
      writeCache(`customer360.${customerId}`, data);
      return data;
    },
    ...(cached
      ? { initialData: cached.data, initialDataUpdatedAt: Date.parse(cached.savedAt) }
      : {}),
    staleTime: 30_000,
  });
}

/** 客户时间线：移动端一次取首屏（50 条），不在手机上无限翻页。 */
export function useCustomerTimeline(customerId: string, limit = 50) {
  const cached = readCache<CustomerTimelinePage>(`customerTimeline.${customerId}.${limit}`);
  return useQuery({
    // limit 属于请求参数，进 key，避免不同页大小共用一份缓存。
    queryKey: [...queryKeys.customerTimeline(customerId, []), limit],
    queryFn: async () => {
      const data = await api.customerTimeline(customerId, { limit });
      writeCache(`customerTimeline.${customerId}.${limit}`, data);
      return data;
    },
    ...(cached
      ? { initialData: cached.data, initialDataUpdatedAt: Date.parse(cached.savedAt) }
      : {}),
    staleTime: 30_000,
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

/**
 * 当前成员的能力（服务端 `/api/auth/me` 算好的 `capabilities`）。
 *
 * 页面只按它显隐，不在前端从角色推导权限：报价「批准并分享 / 提交审批」
 * 这类分支一旦各写一份，迟早与后端白名单不一致。
 * 未就绪（加载中 / 待选租户 / 无成员）返回空数组，界面按「无权限」保守显示。
 */
export function useCapabilities(): Capability[] {
  const query = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api.me(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const data = query.data;
  if (!data || !("capabilities" in data)) return [];
  return data.capabilities;
}

export function useCanApproveQuote(): boolean {
  return useCapabilities().includes("quote.approve");
}
