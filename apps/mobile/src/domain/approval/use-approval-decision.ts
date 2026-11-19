import Taro from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, queryKeys } from "@weave-order/core";
import type { ApprovalItem } from "@weave-order/schema";
import { verifyLargeAmount } from "../../lib/biometric";
import { enqueueOperation } from "../../lib/offline";
import { api, offlineQueue, prefs } from "../../lib/runtime";

/**
 * 审批决策的领域层：审批页与待办内联批共用同一份逻辑。
 *
 * 一次决策的生命周期：
 * 1. `schedule` 只记下「待提交」，卡片留在原地，5 秒内可 `cancelUndo`；
 * 2. 超时 `commit`：大额二次验证 → 调 `api.decideApproval`；
 * 3. 成功：从所有审批缓存里摘掉这一条，刷新全景与动态；
 * 4. 断网 / 网络异常：入 `quote.decide` 离线队列，同样先从缓存摘掉（本地已生效）；
 * 5. 409：服务端版本已变，提示后刷新队列，不覆盖别人的决定。
 *
 * 页面只提供「批准后做什么」（审批页开分享 Sheet，待办只提示），其余行为一致。
 */

export const UNDO_WINDOW_MS = 5000;

export type ApprovalDecisionKind = "APPROVE" | "REJECT";

export interface PendingDecision {
  item: ApprovalItem;
  decision: ApprovalDecisionKind;
  note?: string;
}

export interface UseApprovalDecisionOptions {
  /** 批准成功（或已入离线队列）后的页面动作。 */
  onApproved?: (item: ApprovalItem) => void;
  onRejected?: (item: ApprovalItem) => void;
  /** 进入离线队列时额外通知页面（默认已 toast）。 */
  onQueuedOffline?: (item: ApprovalItem) => void;
}

function withoutItem(current: unknown, id: string): unknown {
  if (!current || typeof current !== "object") return current;
  if ("pages" in current && Array.isArray(current.pages)) {
    return {
      ...current,
      pages: current.pages.map((page: unknown) => {
        if (!page || typeof page !== "object" || !("items" in page)) return page;
        if (!Array.isArray(page.items)) return page;
        const items = page.items as ApprovalItem[];
        return { ...page, items: items.filter((item) => item.id !== id) };
      }),
    };
  }
  if ("items" in current && Array.isArray(current.items)) {
    const items = current.items as ApprovalItem[];
    return { ...current, items: items.filter((item) => item.id !== id) };
  }
  return current;
}

export function useApprovalDecision(options: UseApprovalDecisionOptions = {}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);

  // 页面每次渲染都可能传新的回调；定时器里必须读到最新的一份。
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    timeoutRef.current = null;
    countdownRef.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  /** 审批缓存有两种形状（列表页 `approvals`、游标分页 `approvalQueue`），按 key 前缀统一摘除。 */
  const removeFromCache = useCallback(
    (id: string) => {
      for (const query of queryClient.getQueryCache().findAll({ queryKey: queryKeys.approvals })) {
        queryClient.setQueryData(query.queryKey, (current: unknown) => withoutItem(current, id));
      }
    },
    [queryClient],
  );

  const refreshQueues = useCallback(async () => {
    // ["approvals"] 同时匹配列表与游标分页两条 key。
    await queryClient.invalidateQueries({ queryKey: queryKeys.approvals });
  }, [queryClient]);

  const refreshAfterDecision = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.panorama }),
      queryClient.invalidateQueries({ queryKey: ["audit"] }),
    ]);
  }, [queryClient]);

  const commit = useCallback(
    async (state: PendingDecision) => {
      setBusy(true);
      try {
        if (state.decision === "APPROVE" && state.item.amountCents !== null) {
          const verified = await verifyLargeAmount(
            state.item.amountCents,
            prefs.getLargeApprovalThresholdCents(),
          );
          if (!verified.verified) {
            await Taro.showModal({
              title: "需要二次验证",
              content: verified.message ?? "未通过验证，本次未提交。",
              showCancel: false,
            });
            return;
          }
        }

        const result = await api.decideApproval({
          id: state.item.id,
          kind: state.item.kind,
          decision: state.decision,
          ...(state.note ? { note: state.note.slice(0, 500) } : {}),
        });
        if (!result.ok) {
          await Taro.showToast({ title: result.error.message, icon: "none" });
          await refreshQueues();
          return;
        }

        removeFromCache(state.item.id);
        await refreshAfterDecision();
        if (state.decision === "APPROVE") optionsRef.current.onApproved?.(state.item);
        else optionsRef.current.onRejected?.(state.item);
      } catch (error) {
        if (!(error instanceof ApiError)) {
          // 断网：语义上用户已经做了决定，进队列，恢复联网后按时间序补交。
          await enqueueOperation(offlineQueue, {
            kind: "quote.decide",
            opId: `decide-${state.item.id}-${Date.now()}`,
            payload: {
              id: state.item.id,
              kind: state.item.kind,
              decision: state.decision,
              ...(state.note ? { note: state.note.slice(0, 500) } : {}),
            },
          });
          removeFromCache(state.item.id);
          await Taro.showToast({ title: "已存本地，联网后提交", icon: "none" });
          optionsRef.current.onQueuedOffline?.(state.item);
        } else if (error.status === 409) {
          await Taro.showModal({
            title: "已被其他端处理",
            content: "服务端版本已变化，已刷新队列；请确认后再操作。",
            showCancel: false,
          });
          await refreshQueues();
        } else {
          await Taro.showToast({ title: error.message, icon: "none" });
          await refreshQueues();
        }
      } finally {
        setBusy(false);
        setPending(null);
        setSecondsLeft(0);
        clearTimers();
      }
    },
    [clearTimers, refreshAfterDecision, refreshQueues, removeFromCache],
  );

  /** 记下决定但不提交：卡片留在原地，5 秒内可撤销。 */
  const schedule = useCallback(
    (item: ApprovalItem, decision: ApprovalDecisionKind, note?: string) => {
      const state: PendingDecision = { item, decision, ...(note ? { note } : {}) };
      setPending(state);
      setSecondsLeft(Math.round(UNDO_WINDOW_MS / 1000));
      clearTimers();
      countdownRef.current = setInterval(
        () => setSecondsLeft((value) => Math.max(0, value - 1)),
        1000,
      );
      timeoutRef.current = setTimeout(() => {
        void commit(state);
      }, UNDO_WINDOW_MS);
    },
    [clearTimers, commit],
  );

  const cancelUndo = useCallback(() => {
    clearTimers();
    setPending(null);
    setSecondsLeft(0);
  }, [clearTimers]);

  return { busy, pending, secondsLeft, schedule, cancelUndo };
}
