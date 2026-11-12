import type { QuoteCompanyHeader } from "@weave-order/schema";

/**
 * 报价单抬头与条款的部署方配置。
 *
 * 报价单是给客户看的正式文件，公司抬头不能写死在代码里：默认值只保证本地演示
 * 和测试能跑通，真实部署必须用环境变量覆盖（`docker-compose.yml` 里按需注入，
 * 不需要改镜像）。
 */
const DEMO_COMPANY: QuoteCompanyHeader = {
  name: "织序纺织有限公司",
  address: null,
  phone: null,
  email: null,
};

/** 默认条款：只写可核对的事实，不臆造税务/法律承诺。 */
const DEFAULT_TERMS = [
  "本报价单所列价格与计量单位以下表为准。",
  "报价有效期见下方「有效期」一栏，逾期需重新确认。",
  "大货品质以双方确认的样品为准。",
  "付款方式、交货期与运输条款以双方确认的订单为准。",
  "本报价单经双方确认后生效。",
];

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** 读取公司抬头：WEAVE_COMPANY_NAME / ADDRESS / PHONE / EMAIL。 */
export function loadQuoteCompany(env: NodeJS.ProcessEnv = process.env): QuoteCompanyHeader {
  return {
    name: optional(env.WEAVE_COMPANY_NAME) ?? DEMO_COMPANY.name,
    address: optional(env.WEAVE_COMPANY_ADDRESS) ?? DEMO_COMPANY.address,
    phone: optional(env.WEAVE_COMPANY_PHONE) ?? DEMO_COMPANY.phone,
    email: optional(env.WEAVE_COMPANY_EMAIL) ?? DEMO_COMPANY.email,
  };
}

/** 读取条款：`WEAVE_QUOTE_TERMS` 用 `|` 分隔多条，留空则用默认条款。 */
export function loadQuoteTerms(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.WEAVE_QUOTE_TERMS;
  if (!raw?.trim()) return [...DEFAULT_TERMS];
  const terms = raw
    .split("|")
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  return terms.length > 0 ? terms : [...DEFAULT_TERMS];
}
