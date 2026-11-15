"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys, useTenantContext } from "@weave-order/core";
import type { Persona, PersonaKey } from "@weave-order/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/providers";
import { ROLE_LABEL } from "@/tenant-switch";

/**
 * 本地 dev 的身份条（WAN-136）。
 *
 * 右下角常驻，⌘⇧I 展开 7 个 persona。切换不是「前端换一个角色变量」，而是
 * 调 dev 端点换一把服务端会话；成功后清掉 react-query 缓存并让活跃查询用新会话
 * 重新拉取，**不整页 reload、保留当前路由**。
 *
 * `queryClient.clear()` 会把活跃 observer 从 cache 上摘掉，之后即使
 * `invalidateQueries()` 也不会重新拉（实测），而验收要求「切换后界面随角色变化」。
 * 因此这里用 `resetQueries()`：同样是「全部缓存作废」，但保留订阅并立刻重取。
 *
 * 生产镜像里 `/api/dev/personas` 是 404，查询失败后组件返回 null，不会留下任何入口。
 */
export function PersonaBar() {
  const api = useApi();
  const queryClient = useQueryClient();
  const tenantContext = useTenantContext(api);
  /*
   * 是否显示由「服务端有没有 dev 路由」决定，而不是构建期 NODE_ENV：
   * `next start`（e2e）会把 NODE_ENV 固定成 production，但 API 仍是 AUTH_MODE=dev。
   * 生产/OIDC 镜像里这个请求 404，查询失败后组件返回 null，不留下任何入口。
   */
  const enabled = typeof window !== "undefined";

  const personasQuery = useQuery({
    queryKey: ["dev", "personas"],
    queryFn: () => api.devPersonas(),
    enabled,
    // 老浏览器标签 / 非 dev 后端：404 就静静隐藏，不做重试噪声。
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // 切换后 resetQueries 会让目录短暂进入 pending；用 ref 保住列表，避免身份条闪没。
  const cachedPersonas = useRef<Persona[]>([]);
  if (personasQuery.data) cachedPersonas.current = personasQuery.data;
  const personas = personasQuery.data ?? cachedPersonas.current;

  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<PersonaKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentSubject = tenantContext.status === "READY" ? tenantContext.membership.subject : null;
  const current = personas.find((persona) => persona.subject === currentSubject) ?? null;
  const currentLabel = current ? ROLE_LABEL[current.role] : "未匹配";

  const switchPersona = useCallback(
    async (personaKey: PersonaKey) => {
      if (switching) return;
      setSwitching(personaKey);
      setError(null);
      try {
        const context = await api.devSwitchPersona(personaKey);
        // 全部业务数据都属于上一把会话：作废并用新会话重拉（不是整页刷新）。
        await queryClient.resetQueries();
        queryClient.setQueryData(queryKeys.me, context);
        await queryClient.invalidateQueries({ queryKey: queryKeys.me });
        setOpen(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "切换身份失败");
      } finally {
        setSwitching(null);
      }
    },
    [api, queryClient, switching],
  );

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      if (event.key.toLowerCase() !== "i") return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  /*
   * e2e 深链：`?as=<personaKey>` 只给自动化用，产品界面不暴露。
   * 处理完把参数从地址栏去掉，避免刷新时重复切换 / 用户误以为这是产品功能。
   * 零成员 / 停用成员 / 暂停租户这些异常态由 scenes fixture 负责，不在这里造。
   */
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (!enabled || deepLinkHandled.current || personas.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("as");
    if (!requested) return;
    if (!personas.some((persona) => persona.key === requested)) return;
    deepLinkHandled.current = true;
    params.delete("as");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
    if (requested !== current?.key) void switchPersona(requested as PersonaKey);
  }, [enabled, personas, current?.key, switchPersona]);

  if (!enabled || personas.length === 0) return null;

  return (
    <div
      data-testid="persona-bar"
      className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2"
    >
      {open && (
        <section
          aria-label="切换演示身份"
          className="w-64 rounded-lg border border-line bg-surface p-2 shadow-card"
        >
          <header className="flex items-center justify-between px-2 py-1">
            <p className="text-xs font-medium text-ink-700">切换演示身份</p>
            <button
              type="button"
              aria-label="关闭身份条"
              onClick={() => setOpen(false)}
              className="rounded px-1 text-xs text-ink-400 hover:text-ink-700"
            >
              ✕
            </button>
          </header>
          <div role="listbox" aria-label="演示身份" className="flex flex-col gap-0.5">
            {personas.map((persona) => {
              const active = persona.key === current?.key;
              return (
                <button
                  key={persona.key}
                  type="button"
                  role="option"
                  aria-selected={active}
                  aria-current={active ? "true" : undefined}
                  disabled={active || switching !== null}
                  onClick={() => void switchPersona(persona.key)}
                  className={`flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${
                    active
                      ? "bg-indigo-100 font-medium text-indigo-600"
                      : "text-ink-700 hover:bg-paper disabled:opacity-50"
                  }`}
                >
                  <span>{ROLE_LABEL[persona.role]}</span>
                  <span className="text-[10px] uppercase tracking-wide text-ink-400">
                    {switching === persona.key ? "切换中…" : active ? "当前" : persona.key}
                  </span>
                </button>
              );
            })}
          </div>
          {error && (
            <p role="alert" className="mt-1 px-2 py-1 text-xs text-vermilion-600">
              {error}
            </p>
          )}
        </section>
      )}

      <button
        type="button"
        aria-label={`身份切换（⌘⇧I），当前：${currentLabel}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-9 items-center gap-2 rounded-full border border-line bg-surface px-3 text-xs text-ink-700 shadow-card hover:border-ink-400"
      >
        <span aria-hidden>◉</span>
        身份：{currentLabel}
        <span className="text-ink-400">⌘⇧I</span>
      </button>
    </div>
  );
}
