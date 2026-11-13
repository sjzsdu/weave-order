import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalDecisionInput, ApprovalKind, Unit } from "@weave-order/schema";
import type { ApiClient } from "./api-client";

/** 统一的 query key，避免各端自造字符串。 */
export const queryKeys = {
  me: ["auth", "me"] as const,
  customers: (limit: number) => ["customers", limit] as const,
  panorama: ["panorama"] as const,
  approvals: ["approvals"] as const,
  approvalQueue: (limit: number) => ["approvals", "queue", limit] as const,
  approvalDetail: (id: string, kind: ApprovalKind) => ["approvals", id, kind] as const,
  audit: (limit: number) => ["audit", limit] as const,
  orders: (limit: number) => ["orders", limit] as const,
  order: (id: string) => ["order", id] as const,
  orderShipments: (id: string) => ["order", id, "shipments"] as const,
  shippingPending: ["shipping", "pending"] as const,
  printCenter: ["print", "center"] as const,
  shipment: (id: string) => ["shipment", id] as const,
};

export function useAuthContext(client: ApiClient) {
  return useQuery({ queryKey: queryKeys.me, queryFn: () => client.me() });
}

export function useCustomers(client: ApiClient, limit = 20) {
  return useQuery({
    queryKey: queryKeys.customers(limit),
    queryFn: () => client.listCustomers(limit),
  });
}

export function usePanorama(client: ApiClient) {
  return useQuery({ queryKey: queryKeys.panorama, queryFn: () => client.panorama() });
}

export function useApprovals(client: ApiClient) {
  return useQuery({ queryKey: queryKeys.approvals, queryFn: () => client.approvals() });
}

/**
 * 审批队列（游标分页）：返回所有已加载页的合并列表。
 *
 * 单独用一个 key（`["approvals","queue",limit]`），避免与 `useApprovals`
 * 的单页缓存互相覆盖；`useDecideApproval` 失效 `["approvals"]` 时会连带
 * 失效这里的所有页。
 */
export function useApprovalQueue(client: ApiClient, limit = 50) {
  const queue = useInfiniteQuery({
    queryKey: queryKeys.approvalQueue(limit),
    queryFn: ({ pageParam }) => client.approvals({ cursor: pageParam, limit }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
  });

  const items = queue.data?.pages.flatMap((page) => page.items) ?? [];
  const totalLoaded = items.length;
  return { ...queue, items, totalLoaded, hasMore: queue.hasNextPage };
}

export function useApprovalDetail(client: ApiClient, id: string | null, kind: ApprovalKind) {
  return useQuery({
    queryKey: queryKeys.approvalDetail(id ?? "none", kind),
    queryFn: () => client.approvalDetail(id as string, kind),
    enabled: id !== null,
  });
}

/**
 * 审批决策：成功后刷新审批队列与全景，保证「批完立刻消失」。
 * 失败不乐观更新（金额类动作不允许前端先行生效）。
 */
export function useDecideApproval(client: ApiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ApprovalDecisionInput) => client.decideApproval(input),
    onSuccess: async (_result, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals }),
        queryClient.invalidateQueries({ queryKey: queryKeys.panorama }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.approvalDetail(input.id, input.kind),
        }),
      ]);
    },
  });
}

export function useOrders(client: ApiClient, limit = 50) {
  return useQuery({
    queryKey: queryKeys.orders(limit),
    queryFn: () => client.orders(limit),
  });
}

export function useOrder(client: ApiClient, orderId: string | null) {
  return useQuery({
    queryKey: queryKeys.order(orderId ?? "none"),
    queryFn: () => client.order(orderId as string),
    enabled: orderId !== null,
  });
}

export function useOrderShipments(client: ApiClient, orderId: string | null) {
  return useQuery({
    queryKey: queryKeys.orderShipments(orderId ?? "none"),
    queryFn: () => client.orderShipments(orderId as string),
    enabled: orderId !== null,
  });
}

export function useShippingPending(client: ApiClient) {
  return useQuery({
    queryKey: queryKeys.shippingPending,
    queryFn: () => client.shippingPending(),
  });
}

/** 打印中心抽屉首屏：队列 / 模板 / 设备 / 记录一次读全。 */
export function usePrintCenter(client: ApiClient) {
  return useQuery({
    queryKey: queryKeys.printCenter,
    queryFn: () => client.printCenter(),
    refetchInterval: 8000,
  });
}

export function useShipment(client: ApiClient, shipmentId: string | null) {
  return useQuery({
    queryKey: queryKeys.shipment(shipmentId ?? "none"),
    queryFn: () => client.shipment(shipmentId as string),
    enabled: shipmentId !== null,
    refetchInterval: 10_000,
  });
}

function usePrinting(client: ApiClient, shipmentId: string | null) {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.printCenter }),
      queryClient.invalidateQueries({ queryKey: queryKeys.shippingPending }),
      shipmentId
        ? queryClient.invalidateQueries({ queryKey: queryKeys.shipment(shipmentId) })
        : Promise.resolve(),
    ]);
  };
}

export function usePrintShipmentBundle(client: ApiClient, shipmentId: string | null) {
  const refresh = usePrinting(client, shipmentId);
  return useMutation({
    mutationFn: (copies: {
      pickingListCopies?: number;
      deliveryNoteCopies?: number;
      boxLabelCopies?: number;
    }) =>
      client.printShipmentBundle({
        shipmentId: shipmentId as string,
        ...copies,
      }),
    onSuccess: refresh,
  });
}

export function useCreateBoxes(client: ApiClient, shipmentId: string | null) {
  const refresh = usePrinting(client, shipmentId);
  return useMutation({
    mutationFn: (count: number) =>
      client.createBoxes(shipmentId as string, { count, autoAssign: true }),
    onSuccess: refresh,
  });
}

export function usePickScan(client: ApiClient, shipmentId: string | null) {
  const refresh = usePrinting(client, shipmentId);
  return useMutation({
    mutationFn: (input: { code: string; quantity?: number }) =>
      client.pickScan(shipmentId as string, input),
    onSuccess: refresh,
  });
}

export function useVerifyScan(client: ApiClient, shipmentId: string | null) {
  const refresh = usePrinting(client, shipmentId);
  return useMutation({
    mutationFn: (input: { boxQr: string; itemCode: string; quantity: number }) =>
      client.verifyScan(shipmentId as string, input),
    onSuccess: refresh,
  });
}

export function useReprintBox(client: ApiClient, shipmentId: string | null) {
  const refresh = usePrinting(client, shipmentId);
  return useMutation({
    mutationFn: (input: { boxId: string; reason: Parameters<ApiClient["reprintBox"]>[1] }) =>
      client.reprintBox(input.boxId, input.reason),
    onSuccess: refresh,
  });
}

export function useResolveDiscrepancy(client: ApiClient, shipmentId: string | null) {
  const refresh = usePrinting(client, shipmentId);
  return useMutation({
    mutationFn: (input: { boxId: string; note: string }) =>
      client.resolveDiscrepancy(input.boxId, input.note),
    onSuccess: refresh,
  });
}

export function useShipShipment(client: ApiClient, shipmentId: string | null) {
  const refresh = usePrinting(client, shipmentId);
  return useMutation({
    mutationFn: () => client.shipShipment(shipmentId as string),
    onSuccess: refresh,
  });
}

export function useCreateShipment(client: ApiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      orderId: string;
      carrier?: string | null;
      trackingNumber?: string | null;
      address?: string | null;
      items: Array<{ orderItemId: string; quantity: { value: number; unit: Unit } }>;
    }) =>
      client.createShipment(input.orderId, {
        carrier: input.carrier,
        trackingNumber: input.trackingNumber,
        address: input.address,
        items: input.items,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.shippingPending }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orders(50) }),
        queryClient.invalidateQueries({ queryKey: ["order"] }),
      ]);
    },
  });
}

export function useCancelPrintJob(client: ApiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => client.cancelPrintJob(jobId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.printCenter });
    },
  });
}

export function useRetryPrintJob(client: ApiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => client.retryPrintJob(jobId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.printCenter });
    },
  });
}

export function useRegisterPrintAgent(client: ApiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; location?: string | null }) =>
      client.registerPrintAgent(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.printCenter });
    },
  });
}
