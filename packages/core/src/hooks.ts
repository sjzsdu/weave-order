import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalDecisionInput } from "@weave-order/schema";
import type { ApiClient } from "./api-client";

/** 统一的 query key，避免各端自造字符串。 */
export const queryKeys = {
  me: ["auth", "me"] as const,
  customers: (limit: number) => ["customers", limit] as const,
  panorama: ["panorama"] as const,
  approvals: ["approvals"] as const,
  audit: (limit: number) => ["audit", limit] as const,
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
 * 审批决策：成功后刷新审批队列与全景，保证「批完立刻消失」。
 * 失败不乐观更新（金额类动作不允许前端先行生效）。
 */
export function useDecideApproval(client: ApiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ApprovalDecisionInput) => client.decideApproval(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals }),
        queryClient.invalidateQueries({ queryKey: queryKeys.panorama }),
      ]);
    },
  });
}
