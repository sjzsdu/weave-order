import type { Customer, Quantity, Unit } from "@weave-order/schema";

/**
 * 客户原话 → 报价槽位（本地确定性解析）。
 *
 * P0 手机端要能离线/弱网先用：这里只做「可解释的槽位抽取」，
 * 不假装理解一切。解析结果全部可点开修改；真正的语义解析由 Track B
 * 的智能体在服务端完成，接入后把 `parseCustomerText` 换成 `/api/tools/...`。
 */

export type ParseConfidence = "high" | "medium" | "low";

export interface ParsedSlots {
  /** 原话中出现的客户名（能匹配到已知客户时）。 */
  customerId: string | null;
  customerName: string | null;
  composition: string | null;
  weight: string | null;
  quantity: Quantity | null;
  /** 客户提到的目标价（分）；没提就是 null，由报价助给出建议。 */
  targetPriceCents: number | null;
  deliveryHint: string | null;
  /** 找样用的检索词。 */
  query: string;
  confidence: ParseConfidence;
  /** 缺什么，直接显示成黄色徽标，不显示伪精确的置信度百分比。 */
  missing: string[];
  /** 命中的词，用于「系统听懂了什么」。 */
  hits: string[];
}

const UNIT_WORDS: Array<{ pattern: RegExp; unit: Unit }> = [
  { pattern: /(米|公尺|m(?![a-z])|meters?)/i, unit: "meter" },
  { pattern: /(公斤|千克|kg|kgs?|kilograms?)/i, unit: "kilogram" },
  { pattern: /(码|yard|yds?|yards?)/i, unit: "yard" },
  { pattern: /(件|个|条|支|pcs?|pieces?)/i, unit: "piece" },
];

const COMPOSITIONS = [
  "精梳棉",
  "普梳棉",
  "有机棉",
  "涤棉",
  "棉",
  "涤纶",
  "聚酯纤维",
  "亚麻",
  "苎麻",
  "锦纶",
  "尼龙",
  "羊毛",
  "羊绒",
  "真丝",
  "桑蚕丝",
  "莫代尔",
  "天丝",
  "氨纶",
  "粘胶",
];

function matchComposition(text: string): string | null {
  // 长词优先：精梳棉 命中后不再返回 棉。
  for (const word of [...COMPOSITIONS].sort((a, b) => b.length - a.length)) {
    if (text.includes(word)) return word;
  }
  return null;
}

function matchQuantity(text: string): { quantity: Quantity; hit: string } | null {
  for (const { pattern, unit } of UNIT_WORDS) {
    const unitMatch = pattern.exec(text);
    if (!unitMatch || unitMatch.index === undefined) continue;
    const before = text.slice(0, unitMatch.index);
    const numberMatch = /(\d+(?:\.\d+)?)\s*$/.exec(before);
    if (!numberMatch?.[1]) continue;
    const value = Number(numberMatch[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    return {
      quantity: { value, unit },
      hit: `${numberMatch[1]}${unitMatch[0]}`,
    };
  }
  return null;
}

function matchWeight(text: string): string | null {
  const match = /(\d+(?:\.\d+)?)\s*(?:gsm|g(?![a-z])|克)/i.exec(text);
  if (!match?.[1]) return null;
  return `${match[1]}g`;
}

function matchPrice(text: string): number | null {
  // 只认带货币标记的数字，避免把「500 米」误判成价格。
  const match =
    /(?:单价|价格|报(?:价)?|每米|元\/米)?\s*(\d+(?:\.\d+)?)\s*(?:元|块|rmb|人民币)/i.exec(text);
  if (!match?.[1]) return null;
  const yuan = Number(match[1]);
  if (!Number.isFinite(yuan) || yuan <= 0) return null;
  return Math.round(yuan * 100);
}

function matchDelivery(text: string): string | null {
  const explicit = /(\d+)\s*(?:天|日内|个工作日)/.exec(text);
  if (explicit?.[0]) return explicit[0];
  if (/下周/.test(text)) return "下周";
  if (/月底/.test(text)) return "月底";
  if (/尽快/.test(text)) return "尽快";
  if (/现货/.test(text)) return "现货";
  return null;
}

function matchCustomer(text: string, customers: Customer[]): Customer | null {
  let best: Customer | null = null;
  let bestLength = 0;
  for (const customer of customers) {
    if (customer.name.length < 2) continue;
    // 客户常说简称（「华瑞」指「华瑞制衣」）：从全长往前找最长的可命中前缀。
    for (let length = customer.name.length; length >= 2; length -= 1) {
      if (!text.includes(customer.name.slice(0, length))) continue;
      if (length > bestLength) {
        best = customer;
        bestLength = length;
      }
      break;
    }
  }
  return best;
}

export function parseCustomerText(raw: string, customers: Customer[] = []): ParsedSlots {
  const text = raw.trim();
  const customer = matchCustomer(text, customers);
  const composition = matchComposition(text);
  const weight = matchWeight(text);
  const quantityHit = matchQuantity(text);
  const price = matchPrice(text);
  const delivery = matchDelivery(text);

  const queryParts = [composition, weight].filter((part): part is string => Boolean(part));
  const query = queryParts.join(" ").trim() || text.slice(0, 30);

  const missing: string[] = [];
  if (!customer) missing.push("客户");
  if (!quantityHit) missing.push("数量");
  if (!composition && !weight) missing.push("规格");
  if (price === null) missing.push("单价（可让报价助手建议）");

  const found = [customer, composition, weight, quantityHit, price].filter(Boolean).length;
  const confidence: ParseConfidence = found >= 4 ? "high" : found >= 2 ? "medium" : "low";

  const hits: string[] = [];
  if (customer) hits.push(`客户：${customer.name}`);
  if (composition) hits.push(`成分：${composition}`);
  if (weight) hits.push(`克重：${weight}`);
  if (quantityHit) hits.push(`数量：${quantityHit.hit}`);
  if (price !== null) hits.push(`目标价：${(price / 100).toFixed(2)} 元`);
  if (delivery) hits.push(`交期：${delivery}`);

  return {
    customerId: customer?.id ?? null,
    customerName: customer?.name ?? null,
    composition,
    weight,
    quantity: quantityHit?.quantity ?? null,
    targetPriceCents: price,
    deliveryHint: delivery,
    query,
    confidence,
    missing,
    hits,
  };
}

/** 小程序的 Textarea / Input 都按字符串回传，用它把「15.2」安全转成分。 */
export function yuanInputToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
}

export function centsToYuanInput(cents: number): string {
  return (cents / 100).toFixed(2);
}
