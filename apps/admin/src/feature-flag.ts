/**
 * 功能开关表单的纯逻辑：便于单测，也避免校验规则散落在组件里。
 * 与 `FeatureFlagCreateInput`（packages/schema）保持一致。
 */

export const FLAG_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FeatureFlagDraft = {
  key: string;
  name: string;
  description: string;
  /** 输入框里的字符串，提交前才转成数字。 */
  rollout: string;
  /** 逗号（中英文）/空白分隔的租户 ID。 */
  tenantIds: string;
  enabled: boolean;
};

export type DraftProblem = { label: string; message: string };

export function parseTenantIds(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function validateFeatureFlagDraft(draft: FeatureFlagDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const key = draft.key.trim();
  if (!key) problems.push({ label: "开关 Key", message: "请填写" });
  else if (key.length > 64) problems.push({ label: "开关 Key", message: "不能超过 64 个字符" });
  else if (!FLAG_KEY_PATTERN.test(key)) {
    problems.push({
      label: "开关 Key",
      message: "只能包含字母、数字、点、下划线和短横线，且以字母或数字开头",
    });
  }

  const name = draft.name.trim();
  if (!name) problems.push({ label: "名称", message: "请填写" });
  else if (name.length > 128) problems.push({ label: "名称", message: "不能超过 128 个字符" });

  if (draft.description.trim().length > 500) {
    problems.push({ label: "说明", message: "不能超过 500 个字符" });
  }

  const rollout = draft.rollout.trim();
  const percent = Number(rollout);
  if (rollout === "" || !Number.isInteger(percent) || percent < 0 || percent > 100) {
    problems.push({ label: "灰度比例", message: "请填写 0 到 100 之间的整数" });
  }

  const badId = parseTenantIds(draft.tenantIds).find((id) => !UUID_PATTERN.test(id));
  if (badId) problems.push({ label: "指定租户", message: `不是有效的租户 ID：${badId}` });

  return problems;
}

export function featureFlagPayload(draft: FeatureFlagDraft) {
  const description = draft.description.trim();
  return {
    key: draft.key.trim(),
    name: draft.name.trim(),
    ...(description ? { description } : {}),
    enabled: draft.enabled,
    rolloutPercent: Number(draft.rollout.trim()),
    tenantIds: parseTenantIds(draft.tenantIds),
  };
}
