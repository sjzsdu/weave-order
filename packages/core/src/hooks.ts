import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApprovalDecisionInput,
  ApprovalKind,
  AuthContextResponse,
  Capability,
  CustomerListOptions,
  CustomerTimelineKind,
  TenantChoice,
  Unit,
} from "@weave-order/schema";
import { ApiError } from "./api-client";
import type { ApiClient } from "./api-client";

/** 统一的 query key，避免各端自造字符串。 */
export const queryKeys = {
  me: ["auth", "me"] as const,
  customers: (limit: number) => ["customers", limit] as const,
  customerList: (filters: CustomerListOptions) => ["customers", "list", filters] as const,
  customer360: (id: string) => ["customers", id, "360"] as const,
  customerTimeline: (id: string, kinds: CustomerTimelineKind[]) =>
    ["customers", id, "timeline", kinds.join(",")] as const,
  panorama: ["panorama"] as const,
  intents: ["intents", "recent"] as const,
  approvals: ["approvals"] as const,
  demoScenes: ["demo", "scenes"] as const,
  demoScene: (key: string) => ["demo", "scene", key] as const,
  approvalQueue: (limit: number) => ["approvals", "queue", limit] as const,
  approvalDetail: (id: string, kind: ApprovalKind) => ["approvals", id, kind] as const,
  audit: (limit: number) => ["audit", limit] as const,
  orders: (limit: number) => ["orders", limit] as const,
  orderList: (filters: unknown) => ["orders", "list", filters] as const,
  orderFunnel: (filters: unknown) => ["orders", "funnel", filters] as const,
  orderWorkbench: (id: string) => ["order", id, "workbench"] as const,
  receivables: (filters: unknown) => ["receivables", "list", filters] as const,
  statement: (customerId: string, range: unknown) =>
    ["receivables", "statement", customerId, range] as const,
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

/** 客户列表：筛选与分页都交给后端，前端不做聚合。 */
export function useCustomerList(client: ApiClient, filters: CustomerListOptions = {}) {
  return useQuery({
    queryKey: queryKeys.customerList(filters),
    queryFn: () => client.customerList(filters),
  });
}

export function useCustomer360(client: ApiClient, customerId: string | null) {
  return useQuery({
    queryKey: queryKeys.customer360(customerId ?? "none"),
    queryFn: () => client.customer360(customerId as string),
    enabled: customerId !== null,
    // 越权 / 不存在是稳定结果，重试只会拖慢 404 页面。
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
}

/**
 * 客户时间线：游标分页，首屏 20 条，加载更多只追加不重拉。
 * 按类型筛选时换一个 query key，避免不同筛选的页混在一起。
 */
export function useCustomerTimeline(
  client: ApiClient,
  customerId: string | null,
  kinds: CustomerTimelineKind[] = [],
  limit = 20,
) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.customerTimeline(customerId ?? "none", kinds),
    queryFn: ({ pageParam }) =>
      client.customerTimeline(customerId as string, {
        kinds,
        limit,
        cursor: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    enabled: customerId !== null,
  });
  const events = query.data?.pages.flatMap((page) => page.events) ?? [];
  return { ...query, events, hasMore: query.hasNextPage };
}

export function usePanorama(client: ApiClient) {
  return useQuery({ queryKey: queryKeys.panorama, queryFn: () => client.panorama() });
}

export function useApprovals(client: ApiClient) {
  return useQuery({ queryKey: queryKeys.approvals, queryFn: () => client.approvals() });
}

/**
 * 剧本深链（`/today?scene=<key>`）。
 *
 * 生产环境接口不存在（404），`enabled` 只在 URL 带 scene 时才发请求，
 * 页面其余部分零影响。返回的 `entityId` 用于高亮列表项。
 */
export function useDemoScene(client: ApiClient, key: string | null) {
  return useQuery({
    queryKey: queryKeys.demoScene(key ?? "none"),
    queryFn: () => client.demoScene(key as string),
    enabled: key !== null,
    retry: false,
  });
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

export interface OrderListFilters {
  statuses?: string[];
  customerId?: string;
  dueFrom?: string;
  dueBefore?: string;
  overdueOnly?: boolean;
}

/** 订单列表（游标分页）：返回已加载页的合并列表。 */
export function useOrderList(client: ApiClient, filters: OrderListFilters = {}) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.orderList(filters),
    queryFn: ({ pageParam }) => client.orders({ ...filters, cursor: pageParam, limit: 20 }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.orders) ?? [];
  return { ...query, items, total: query.data?.pages[0]?.total ?? 0 };
}

/** 漏斗数字：筛选与列表一致（不含状态），点进去条数刚好对上。 */
export function useOrderFunnel(
  client: ApiClient,
  filters: Omit<OrderListFilters, "statuses"> = {},
) {
  return useQuery({
    queryKey: queryKeys.orderFunnel(filters),
    queryFn: () => client.orderFunnel(filters),
  });
}

export function useOrderWorkbench(client: ApiClient, orderId: string | null) {
  return useQuery({
    queryKey: queryKeys.orderWorkbench(orderId ?? "none"),
    queryFn: () => client.orderWorkbench(orderId as string),
    enabled: orderId !== null,
  });
}

export type ReceivableBucketFilter = "overdue" | "dueSoon" | "settled" | "all";

/** 应收列表（游标分页）：分组计数与余额随页返回，页面不再自己聚合。 */
export function useReceivableList(
  client: ApiClient,
  filters: { bucket: ReceivableBucketFilter; customerId?: string },
) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.receivables(filters),
    queryFn: ({ pageParam }) => client.receivables({ ...filters, cursor: pageParam, limit: 20 }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.receivables) ?? [];
  return { ...query, items, summary: query.data?.pages[0]?.summary ?? null };
}

/**
 * 登记回款：成功后失效应收、对账单、订单与全景，
 * 验收要求「余额 / 逾期状态 / 全景数字同步变化，无需刷新页面」。
 */
export function useRecordPayment(client: ApiClient, receivableId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      amount: { amount: number; currency: string };
      paidAt?: string;
      note?: string | null;
      proofObjectKey?: string | null;
    }) => client.recordPayment(receivableId, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["receivables"] }),
        queryClient.invalidateQueries({ queryKey: ["orders"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.panorama }),
      ]);
    },
  });
}

export function useCustomerStatement(
  client: ApiClient,
  customerId: string | null,
  range: { from?: string; to?: string } = {},
) {
  return useQuery({
    queryKey: queryKeys.statement(customerId ?? "none", range),
    queryFn: () => client.statement(customerId as string, range),
    enabled: customerId !== null,
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
        queryClient.invalidateQueries({ queryKey: ["orders"] }),
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

/** 租户上下文状态：前端只按这几种状态渲染，不自己推断。 */
export type TenantContextState =
  | { status: "LOADING" }
  | {
      status: "READY";
      tenant: AuthContextResponse["tenant"];
      membership: AuthContextResponse["membership"];
      /**
       * SSO 给的显示名 / 邮箱：顶栏只能显示这两个，绝不显示 `membership.subject`。
       * 两者都可能为空（IdP 没配 profile），由界面兜底成「我」。
       */
      name: AuthContextResponse["name"];
      email: AuthContextResponse["email"];
      /** 服务端算好的能力清单；前端显隐只读它，不再从 role 推导。 */
      capabilities: AuthContextResponse["capabilities"];
    }
  | { status: "MULTI_TENANT"; tenants: TenantChoice[] }
  | { status: "NO_MEMBERSHIP"; message: string }
  | { status: "ERROR"; message: string };

/**
 * 租户上下文 + 选择 / 切换动作。
 *
 * 切换成功后清空整个 query 缓存再整页重建：租户变了，角色、数据范围、
 * 审批阈值、币种全变了，局部刷新会出现「新租户标题 + 旧租户数据」的混搭。
 * 这里不写 localStorage，也不把 tenantId 塞进后续请求：租户只活在服务端会话里。
 */
export function useTenantContext(client: ApiClient) {
  const queryClient = useQueryClient();
  const me = useAuthContext(client);

  const state: TenantContextState = (() => {
    if (me.isPending) return { status: "LOADING" };
    if (me.isError) {
      const error = me.error;
      if (error instanceof ApiError && error.code === "NO_MEMBERSHIP") {
        return { status: "NO_MEMBERSHIP", message: error.message };
      }
      return { status: "ERROR", message: error instanceof Error ? error.message : "加载失败" };
    }
    const data = me.data;
    if (!data) return { status: "LOADING" };
    if ("tenants" in data) return { status: "MULTI_TENANT", tenants: data.tenants };
    return {
      status: "READY",
      tenant: data.tenant,
      membership: data.membership,
      name: data.name,
      email: data.email,
      capabilities: data.capabilities,
    };
  })();

  const switchMutation = useMutation({
    mutationFn: (tenantId: string) => client.switchTenant({ tenantId }),
    onSuccess: (context) => {
      // 整库清空 + 预置新上下文；页面随后 reload 到工作台（组件决定怎么跳）。
      queryClient.clear();
      queryClient.setQueryData(queryKeys.me, context);
    },
  });

  return {
    ...state,
    /** 首次选择与运行中切换是同一个动作。 */
    select: switchMutation.mutateAsync,
    switching: switchMutation.isPending,
    switchError: switchMutation.error,
    refetch: me.refetch,
  };
}

/**
 * 当前成员是否具备某能力。
 *
 * 只读 `/api/auth/me` 返回的 `capabilities`，不在前端重算角色：
 * 未就绪（加载中 / 待选租户 / 无成员）一律 false，宁可先不显示也不误显示。
 */
export function useCapability(client: ApiClient, capability: Capability): boolean {
  const context = useTenantContext(client);
  return context.status === "READY" && context.capabilities.includes(capability);
}
