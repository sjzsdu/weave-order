export const FIELD_LABEL: Record<string, string> = {
  code: "编号",
  name: "名称",
  tier: "等级",
  contactName: "联系人",
  contactPhone: "手机 / 电话",
  contactEmail: "邮箱",
  composition: "成分",
  category: "品类",
  weight: "克重",
  unit: "单位",
};

/**
 * 「确认可用」被内核拒绝时，把字段键翻成用户能认的名字并给出下一步。
 * 服务端消息形如「还有字段待确认：name, weight」，不能原样丢给老板。
 */
export function confirmErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "确认失败";
  const match = /还有字段待确认[：:]\s*(.+)$/.exec(raw);
  if (!match?.[1]) return raw;
  const labels = match[1]
    .split(/[,，、]\s*/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => FIELD_LABEL[name] ?? name);
  if (labels.length === 0) return raw;
  return `还有字段待确认：${labels.join("、")}。先点「逐字段确认」再确认可用。`;
}
