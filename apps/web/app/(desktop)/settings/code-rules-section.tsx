"use client";

/**
 * 业务编号规则设置（桌面端）。
 *
 * 这里只调 apps/api 的 BFF：admin 控制台只能访问 platform-api，
 * 拿不到租户业务库，所以编号规则的设置页放在 web，不放 admin。
 *
 * 预览与保存共用 packages/schema 的同一套模板解析函数（服务端也用同一份），
 * 前端不自己写正则判断合法性，避免「预览说没问题、保存却拒绝」。
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CODE_ENTITY_LABEL,
  CODE_ENTITY_TYPES,
} from "@weave-order/schema";
import type { CodeEntityType, CodeRule, CodeRuleListResponse } from "@weave-order/schema";
import { Badge, Button, Spinner } from "@weave-order/ui";
import { useApi } from "@/providers";

type PresetOption = CodeRuleListResponse["presets"][number];

const UNCONFIGURED_ID = "00000000-0000-0000-0000-000000000000";

/** 逐实体的兼容性提示，避免用户改规则后对历史单据产生误解。 */
const ENTITY_HINT: Partial<Record<CodeEntityType, string>> = {
  quote: "历史报价编号外观不变，新报价才使用这里的规则。",
  sample: "样品编号会进样卡二维码；改码后旧二维码失效，需要重打。",
  sample_shipment: "历史寄样单没有编号，不回填。",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

export function CodeRulesSection({ canEdit }: { canEdit: boolean }) {
  const api = useApi();
  const rules = useQuery({
    queryKey: ["settings", "code-rules"],
    queryFn: () => api.codeRules(),
    staleTime: 60_000,
  });

  if (rules.isLoading) return <Spinner label="读取编号规则…" />;
  if (rules.isError || !rules.data) {
    return (
      <section className="rounded-lg border border-line bg-surface px-5 py-4">
        <h2 className="text-sm font-medium text-ink-900">业务编号</h2>
        <p className="mt-1 text-xs text-vermilion-600">
          规则读取失败：{messageOf(rules.error)}。刷新页面重试一次。
        </p>
        <Button className="mt-3 min-h-11" onClick={() => void rules.refetch()}>
          重新读取
        </Button>
      </section>
    );
  }

  const byEntity = new Map(rules.data.rules.map((rule) => [rule.entityType, rule]));

  return (
    <section className="grid gap-4">
      <div className="rounded-lg border border-line bg-surface px-5 py-4">
        <h2 className="text-sm font-medium text-ink-900">业务编号</h2>
        <p className="mt-1 text-xs text-ink-400">
          五类单据各自独立配置。系统推荐的模板可以直接一键套用，也可以自己写模板串。
          保存后只影响<strong className="font-medium text-ink-700">之后新建</strong>的记录，
          已经写出的编号不会变。
        </p>
        <p className="mt-2 text-xs text-ink-400">
          可用占位符：{" "}
          <code className="rounded bg-paper px-1 py-0.5 font-mono">
            {"{PREFIX} {YY} {MM} {DD} {YYYY} {YYMMDD} {YYYYMM} {YYYYMMDD} {SEQ:4}"}
          </code>
          。{"{SEQ:n}"} 只能出现一次；样品编号还要塞进二维码，上限 32 字节。
        </p>
        {!canEdit ? (
          <p className="mt-2 text-xs text-amber-600">
            当前角色只有查看权限；修改编号规则需要经理或老板。
          </p>
        ) : null}
      </div>

      {CODE_ENTITY_TYPES.map((entityType) => (
        <CodeRuleCard
          key={entityType}
          entityType={entityType}
          rule={byEntity.get(entityType)}
          presets={rules.data.presets}
          canEdit={canEdit}
        />
      ))}
    </section>
  );
}

function CodeRuleCard({
  entityType,
  rule,
  presets,
  canEdit,
}: {
  entityType: CodeEntityType;
  rule: CodeRule | undefined;
  presets: PresetOption[];
  canEdit: boolean;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [template, setTemplate] = useState(rule?.template ?? "");
  const [presetKey, setPresetKey] = useState<string | null>(rule?.presetKey ?? null);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    setTemplate(rule?.template ?? "");
    setPresetKey(rule?.presetKey ?? null);
  }, [rule?.template, rule?.presetKey]);

  const preview = useQuery({
    queryKey: ["settings", "code-preview", entityType, template],
    queryFn: () => api.previewCodeRule(entityType, template),
    enabled: template.length > 0,
    staleTime: 30_000,
  });

  const save = useMutation({
    mutationFn: () => api.saveCodeRule({ entityType, template, presetKey }),
    onSuccess: (saved) => {
      setFeedback(`已保存：${saved.template}`);
      void queryClient.invalidateQueries({ queryKey: ["settings", "code-rules"] });
    },
    onError: (error) => setFeedback(messageOf(error)),
  });

  const reset = useMutation({
    mutationFn: () => api.resetCodeRule(entityType),
    onSuccess: (saved) => {
      setTemplate(saved.template);
      setPresetKey(saved.presetKey);
      setFeedback(`已恢复默认：${saved.template}`);
      void queryClient.invalidateQueries({ queryKey: ["settings", "code-rules"] });
    },
    onError: (error) => setFeedback(messageOf(error)),
  });

  const dirty =
    template !== (rule?.template ?? "") || presetKey !== (rule?.presetKey ?? null);
  const configured = Boolean(rule && rule.id !== UNCONFIGURED_ID);
  const result = preview.data;

  return (
    <article className="rounded-lg border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-ink-900">{CODE_ENTITY_LABEL[entityType]}</h3>
        <Badge tone={configured ? "success" : "neutral"}>
          {configured ? "已配置" : "默认模板"}
        </Badge>
      </div>

      {ENTITY_HINT[entityType] ? (
        <p className="mt-1 text-xs text-ink-400">{ENTITY_HINT[entityType]}</p>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
        <label className="grid gap-1 text-xs text-ink-400">
          系统推荐
          <select
            className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm text-ink-900 disabled:opacity-60"
            value={presetKey ?? "custom"}
            disabled={!canEdit}
            onChange={(event) => {
              const key = event.target.value === "custom" ? null : event.target.value;
              setPresetKey(key);
              const preset = presets.find((item) => item.key === key);
              const presetTemplate = preset?.templates[entityType];
              if (presetTemplate) setTemplate(presetTemplate);
              setFeedback(null);
            }}
          >
            <option value="custom">自定义</option>
            {presets.map((preset) => (
              <option key={preset.key} value={preset.key}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1 text-xs text-ink-400">
          模板串
          <input
            className="min-h-11 rounded-md border border-line bg-surface px-3 font-mono text-sm text-ink-900 disabled:opacity-60"
            value={template}
            maxLength={128}
            disabled={!canEdit}
            onChange={(event) => {
              setTemplate(event.target.value);
              setPresetKey(null);
              setFeedback(null);
            }}
          />
        </label>
      </div>

      <div className="mt-3 rounded-md bg-paper px-3 py-2">
        {preview.isFetching ? (
          <p className="text-xs text-ink-400">正在生成示例…</p>
        ) : result ? (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {result.examples.map((example) => (
                <code key={example.seq} className="font-mono text-sm text-ink-900">
                  {example.code}
                </code>
              ))}
            </div>
            <p className="text-xs text-ink-400">
              分桶 {result.bucket || "（空）"} · 容量预算 {result.budgetBytes} / 上限 {result.maxBytes} 字节
            </p>
            {result.errors.map((issue) => (
              <p key={issue.code} className="text-xs text-vermilion-600">
                {issue.message}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink-400">输入模板后显示示例。</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          className="min-h-11"
          disabled={!canEdit || !dirty || !result?.valid || save.isPending || reset.isPending}
          onClick={() => {
            setFeedback(null);
            save.mutate();
          }}
        >
          {save.isPending ? "保存中…" : "保存规则"}
        </Button>
        {configured ? (
          <Button
            className="min-h-11"
            disabled={!canEdit || reset.isPending || save.isPending}
            onClick={() => {
              setFeedback(null);
              reset.mutate();
            }}
          >
            {reset.isPending ? "恢复中…" : "恢复默认"}
          </Button>
        ) : null}
        {feedback ? (
          <span className="text-xs text-ink-700" role="status">
            {feedback}
          </span>
        ) : null}
      </div>
    </article>
  );
}
