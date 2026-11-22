/**
 * 克重（g/m²）解析：把 `samples.weight` 原文归一化成整数。
 *
 * 只认「单一数值 + 明确单位」：
 * - `220g/m2` / `220g/㎡` / `220gsm` / `克重220`；
 * - 区间（`220-240`）、纱支（`32S/2`、`32支`）、无单位纯数字（`220`）、
 *   多值混写（`220g/m2 / 240g/m2`）一律返回 `null`。
 *
 * 为什么不用 SQL 抽数字：`replace(weight,'[^0-9]','','g')` 会把 `32S/2` 抽成 322，
 * 把区间抽成两端拼起来的数字，错得看起来却像正常数据。判定逻辑只放在这里，
 * 写入、回填、筛选共用同一份，避免三处口径漂移。
 */

const PREFIX_WEIGHT = /^克重\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:g\s*\/\s*m\s*2|gsm)?$/u;
/** NFKC 已把 `㎡` 折成 `m2`、全角字符折成半角，这里只需处理 ASCII 形态。 */
const SUFFIX_WEIGHT = /^(\d+(?:\.\d+)?)\s*(?:g\s*\/\s*m\s*2|gsm)$/u;
const MAX_REASONABLE_GSM = 20_000;

export function parseWeightGsm(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.normalize("NFKC").trim().toLowerCase();
  if (text === "") return null;
  const match = PREFIX_WEIGHT.exec(text) ?? SUFFIX_WEIGHT.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  // 取整后再判：0.4gsm 四舍五入成 0 会违反 `.positive()` 契约，必须留空。
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > MAX_REASONABLE_GSM) return null;
  return rounded;
}

/** 界面文案：解析不出来时明确说「未填」，不把 null 渲染成 0。 */
export function weightGsmLabel(value: number | null | undefined): string {
  return typeof value === "number" ? `${value} g/m²` : "克重未填";
}

/**
 * 样品卡片的克重展示：老数据的 `weight` 可能只写了一个裸数字（如 `230`）。
 * 这里只负责把单位补全给人看，不把它当成可筛选的 weightGsm（判定仍走 parseWeightGsm）。
 */
export function sampleWeightText(
  weightGsm: number | null | undefined,
  weight: string | null | undefined,
): string | null {
  if (typeof weightGsm === "number") return `${weightGsm} g/m²`;
  const text = weight?.trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return `${Math.round(Number(text))} g/m²`;
  return text;
}
