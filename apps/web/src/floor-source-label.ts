/**
 * 报价依据里的「出处」翻译。
 *
 * 后端把依据写成了数据库口径（`samples.cost_floor(S01) + pricing_policies.min_margin_pct（SYSTEM）`），
 * 用户在事项详情和报价详情看到的是同一个字段，两处必须说同一句人话：翻译只留这一份，
 * 谁再复制一份到页面里，就会出现「往里点一层可读性掉一级」（WAN-219）。
 *
 * 只翻译已知字段，不猜定价规则；未知来源原样返回，宁可露出原文也不把「不知道」显示成空。
 */
export function floorSourceLabel(source: string): string {
  return source
    .replace(/samples\.cost_floor\([^)]*\)/g, "样品成本底线")
    .replaceAll("pricing_policies.min_margin_pct", "最低毛利规则")
    .replaceAll("SYSTEM", "系统默认")
    .replaceAll("COMPANY", "公司")
    .replaceAll("TEAM", "团队")
    .replaceAll("PERSON", "个人")
    .replaceAll("CATEGORY", "品类")
    .replaceAll("CUSTOMER", "客户");
}
