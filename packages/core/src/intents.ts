"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { IntentSource, IntentView, JsonValue } from "@weave-order/schema";
import type { ApiClient } from "./api-client";
import { queryKeys } from "./hooks";

/**
 * 意图通道的唯一前端入口。
 *
 * 页内 composer、顶栏 ⌘K、客户 360 快捷动作都调这个 hook ——
 * 差别只有 `source` 与展示位置，请求、幂等键、轮询、缓存更新都只有一份实现。
 */

/** 非终态才需要轮询；终态（成功/失败/撤销/超时）停下来，不空转。 */
export function isIntentActive(intent: Pick<IntentView, "status">): boolean {
  return intent.status === "QUEUED" || intent.status === "RUNNING";
}

/** 幂等键：一次「提交动作」一个，重试才换新的。 */
export function newClientRequestId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `intent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "提交失败，请稍后重试";
}

function mergeIntent(current: IntentView[] | undefined, next: IntentView): IntentView[] {
  const rest = (current ?? []).filter((intent) => intent.id !== next.id);
  return [next, ...rest].slice(0, 20);
}

export interface IntentChannel {
  /** 近期意图（最新在前）；刷新页面后从这里恢复上次说过的话。 */
  items: IntentView[];
  isLoading: boolean;
  listError: string | null;
  /** 提交中：按钮必须立刻进 loading，防止重复点击。 */
  submitting: boolean;
  /** 提交请求本身的失败（网络/鉴权），不是执行失败。 */
  submitError: string | null;
  /** 提交成功返回落库后的意图；失败返回 null 且错误在 submitError。 */
  submit: (text: string, source: IntentSource, context?: JsonValue) => Promise<IntentView | null>;
  /** 撤销（10 分钟窗口由服务端判定）；返回最新意图或 null。 */
  cancel: (id: string) => Promise<IntentView | null>;
  /** 重试 = 用新幂等键重新提交同一段原文。 */
  retry: (intent: IntentView) => Promise<IntentView | null>;
  clearSubmitError: () => void;
}

export function useIntentChannel(client: ApiClient): IntentChannel {
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: queryKeys.intents,
    queryFn: () => client.intents(20),
    // 有非终态就 2 秒拉一次；全部终结后停表，避免后台空转。
    refetchInterval: (query) => ((query.state.data ?? []).some(isIntentActive) ? 2000 : false),
    staleTime: 1_000,
  });

  const submit = useCallback(
    async (text: string, source: IntentSource, context?: JsonValue) => {
      const trimmed = text.trim();
      if (!trimmed || submitting) return null;
      setSubmitting(true);
      setSubmitError(null);
      try {
        const result = await client.submitIntent({
          text: trimmed,
          source,
          clientRequestId: newClientRequestId(),
          ...(context ? { context } : {}),
        });
        // 立刻插进缓存：不等下一次轮询，卡片 300ms 内可见。
        queryClient.setQueryData<IntentView[]>(queryKeys.intents, (current) =>
          mergeIntent(current, result.intent),
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.intents });
        return result.intent;
      } catch (error) {
        setSubmitError(errorMessage(error));
        return null;
      } finally {
        setSubmitting(false);
      }
    },
    [client, queryClient, submitting],
  );

  const cancel = useCallback(
    async (id: string) => {
      try {
        const intent = await client.cancelIntent(id);
        queryClient.setQueryData<IntentView[]>(queryKeys.intents, (current) =>
          mergeIntent(current, intent),
        );
        return intent;
      } catch (error) {
        setSubmitError(errorMessage(error));
        return null;
      }
    },
    [client, queryClient],
  );

  const retry = useCallback((intent: IntentView) => submit(intent.text, intent.source), [submit]);

  return {
    items: list.data ?? [],
    isLoading: list.isLoading,
    listError: list.error ? errorMessage(list.error) : null,
    submitting,
    submitError,
    submit,
    cancel,
    retry,
    clearSubmitError: () => setSubmitError(null),
  };
}
