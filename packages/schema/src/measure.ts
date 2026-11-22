import { z } from "zod";

/**
 * 度量单位：克重与门幅。
 *
 * 单位取值是**有限集合**，所以「数值」和「单位」分成两个字段各存各的：
 * - 克重：`gsm`（g/m²）/ `oz`（oz/yd²）/ `kgm2`（kg/m²）
 * - 门幅：`cm`（厘米）/ `in`（英寸）/ `m`（米）
 *
 * 为什么不做成自由文本：自由文本要靠正则猜单位，猜错就写出一份看着正常的错数据
 *（`220-240`、`32S/2`、裸数字 `230` 都会被抽成一个假数字）。
 * 单位受控之后，录入面只需要一个数值框 + 一个下拉，判定逻辑不必猜。
 *
 * 换算只在「归一列」这一处发生：克重统一折到 g/m²、门幅统一折到 cm，
 * 用来做区间筛选与比较。**换算是派生不是改写**：用户按 oz 录的事实要留住，
 * 比较时再折算，两套口径不会漂移。
 */

/** 克重单位。 */
export const WeightUnit = z.enum(["gsm", "oz", "kgm2"]);
export type WeightUnit = z.infer<typeof WeightUnit>;

/** 门幅单位。 */
export const WidthUnit = z.enum(["cm", "in", "m"]);
export type WidthUnit = z.infer<typeof WidthUnit>;

/** 克重单位候选（设置页下拉、录入面下拉的顺序）。 */
export const WEIGHT_UNITS: readonly WeightUnit[] = ["gsm", "oz", "kgm2"];

/** 门幅单位候选。 */
export const WIDTH_UNITS: readonly WidthUnit[] = ["cm", "in", "m"];

/** 克重单位显示名。 */
export const WEIGHT_UNIT_LABEL: Record<WeightUnit, string> = {
  gsm: "g/m²",
  oz: "oz/yd²",
  kgm2: "kg/m²",
};

/** 门幅单位显示名。 */
export const WIDTH_UNIT_LABEL: Record<WidthUnit, string> = {
  cm: "cm",
  in: "inch",
  m: "m",
};

/** 检索用后缀（小写、无空格）：克重文本要能被 "220g" 这类检索词命中。 */
const WEIGHT_TEXT_SUFFIX: Record<WeightUnit, string> = {
  gsm: "g/m2",
  oz: "oz/yd2",
  kgm2: "kg/m2",
};

/** 检索用后缀：门幅文本要能被 "150cm" 这类检索词命中。 */
const WIDTH_TEXT_SUFFIX: Record<WidthUnit, string> = {
  cm: "cm",
  in: "in",
  m: "m",
};

/** 一个克重：数值 + 单位，缺一不可。 */
export const WeightMeasurement = z
  .object({
    value: z.number().positive(),
    unit: WeightUnit,
  })
  .strict();
export type WeightMeasurement = z.infer<typeof WeightMeasurement>;

/** 一个门幅：数值 + 单位，缺一不可。 */
export const WidthMeasurement = z
  .object({
    value: z.number().positive(),
    unit: WidthUnit,
  })
  .strict();
export type WidthMeasurement = z.infer<typeof WidthMeasurement>;

/** 1 oz/yd² = 28.3495 g ÷ 0.836127 m² ≈ 33.9059 g/m²。 */
const GSM_PER_OZ_YD2 = 33.9059;
/** 1 英寸 = 2.54 cm（定义值，不折算）。 */
const CM_PER_INCH = 2.54;

/** 克重归一上限：超过这个值不是面料，是录入事故。 */
const MAX_REASONABLE_GSM = 20_000;
/** 门幅归一上限（cm）：10 米以上的门幅没有意义。 */
const MAX_REASONABLE_CM = 5_000;

/** 折算到 g/m²。 */
export function toGsm(value: number, unit: WeightUnit): number {
  if (unit === "gsm") return value;
  if (unit === "oz") return value * GSM_PER_OZ_YD2;
  return value * 1000;
}

/** 折算到 cm。 */
export function toCm(value: number, unit: WidthUnit): number {
  if (unit === "cm") return value;
  if (unit === "in") return value * CM_PER_INCH;
  return value * 100;
}

/** 归一克重（整数 g/m²）：筛选与比较都用它。 */
export function weightGsmOf(measurement: WeightMeasurement): number {
  return Math.round(toGsm(measurement.value, measurement.unit));
}

/** 归一门幅（整数 cm）。 */
export function widthCmOf(measurement: WidthMeasurement): number {
  return Math.round(toCm(measurement.value, measurement.unit));
}

/** 去掉多余小数位：220 → "220"，6.5 → "6.5"，0.22 → "0.22"。 */
function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/** 克重的检索文本（写进 `samples.weight_text`）："220g/m2"、"6.5oz/yd2"。 */
export function weightSearchText(measurement: WeightMeasurement): string {
  return `${trimNumber(measurement.value)}${WEIGHT_TEXT_SUFFIX[measurement.unit]}`;
}

/** 门幅的检索文本："150cm"、"59in"。 */
export function widthSearchText(measurement: WidthMeasurement): string {
  return `${trimNumber(measurement.value)}${WIDTH_TEXT_SUFFIX[measurement.unit]}`;
}

/** 克重展示文案："220 g/m²"。 */
export function weightLabel(measurement: WeightMeasurement | null | undefined): string | null {
  if (!measurement) return null;
  return `${trimNumber(measurement.value)} ${WEIGHT_UNIT_LABEL[measurement.unit]}`;
}

/** 门幅展示文案："150 cm"。 */
export function widthLabel(measurement: WidthMeasurement | null | undefined): string | null {
  if (!measurement) return null;
  return `${trimNumber(measurement.value)} ${WIDTH_UNIT_LABEL[measurement.unit]}`;
}

/**
 * 原文 → 克重（数值 + 单位）。
 *
 * 只认「单一数值 + 明确单位」：
 * - `220g/m2` / `220g/㎡` / `220gsm` / `克重220` → g/m²
 * - `6.5oz/yd2` / `6.5oz` → oz/yd²
 * - `0.22kg/m2` → kg/m²
 *
 * 区间（`220-240`）、纱支（`32S/2`）、无单位纯数字（`220`）、
 * 多值混写（`220g/m2 / 240g/m2`）一律返回 `null`。
 *
 * 为什么不用 SQL 抽数字：`replace(weight,'[^0-9]','','g')` 会把 `32S/2` 抽成 322，
 * 把区间抽成两端拼起来的数字，错得看起来却像正常数据。判定逻辑只放在这里，
 * 写入、回填、筛选共用同一份，避免三处口径漂移。
 */
const WEIGHT_SUFFIX_PATTERN =
  /^(\d+(?:\.\d+)?)\s*(g\s*\/\s*m\s*2|gsm|oz\s*\/\s*yd\s*2|oz|kg\s*\/\s*m\s*2|kg)$/u;
/** 「克重」前缀本身隐含 g/m²，所以单位可省（`克重220`）。 */
const WEIGHT_PREFIX_PATTERN =
  /^克重\s*[:：]?\s*(\d+(?:\.\d+)?)(?:\s*(g\s*\/\s*m\s*2|gsm|oz\s*\/\s*yd\s*2|oz|kg\s*\/\s*m\s*2|kg))?$/u;

function weightUnitFromToken(token: string): WeightUnit | null {
  const compact = token.replace(/\s+/g, "");
  if (compact === "g/m2" || compact === "gsm") return "gsm";
  if (compact === "oz/yd2" || compact === "oz") return "oz";
  if (compact === "kg/m2" || compact === "kg") return "kgm2";
  return null;
}

export function parseWeightMeasurement(
  raw: string | null | undefined,
): WeightMeasurement | null {
  if (raw === null || raw === undefined) return null;
  // NFKC 已把 `㎡` 折成 `m2`、`²` 折成 `2`、全角字符折成半角。
  const text = raw.normalize("NFKC").trim().toLowerCase();
  if (text === "") return null;
  const suffix = WEIGHT_SUFFIX_PATTERN.exec(text);
  const prefix = suffix ? null : WEIGHT_PREFIX_PATTERN.exec(text);
  const match = suffix ?? prefix;
  if (!match) return null;
  const unit = weightUnitFromToken(match[2] ?? "g/m2");
  if (!unit) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const gsm = weightGsmOf({ value, unit });
  // 取整后再判：0.4gsm 四舍五入成 0 会违反 `.positive()` 契约，必须留空。
  if (gsm < 1 || gsm > MAX_REASONABLE_GSM) return null;
  return { value, unit };
}

/**
 * 原文 → 门幅（数值 + 单位）。
 *
 * 认 `150cm` / `59in` / `59inch` / `1.5m` / `门幅150`（前缀隐含 cm）。
 * 区间、无单位纯数字、多值混写一律留空。
 */
const WIDTH_SUFFIX_PATTERN =
  /^(\d+(?:\.\d+)?)\s*(cm|inch|in|厘米|英寸|米|m|")$/u;
/** 「门幅」前缀本身隐含厘米。 */
const WIDTH_PREFIX_PATTERN =
  /^门幅\s*[:：]?\s*(\d+(?:\.\d+)?)(?:\s*(cm|inch|in|厘米|英寸|米|m))?$/u;

function widthUnitFromToken(token: string): WidthUnit | null {
  const compact = token.replace(/\s+/g, "");
  if (compact === "cm" || compact === "厘米") return "cm";
  if (compact === "in" || compact === "inch" || compact === "英寸") return "in";
  if (compact === "m" || compact === "米") return "m";
  return null;
}

export function parseWidthMeasurement(raw: string | null | undefined): WidthMeasurement | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.normalize("NFKC").trim().toLowerCase();
  if (text === "") return null;
  const suffix = WIDTH_SUFFIX_PATTERN.exec(text);
  const prefix = suffix ? null : WIDTH_PREFIX_PATTERN.exec(text);
  const match = suffix ?? prefix;
  if (!match) return null;
  const unit = widthUnitFromToken(match[2] ?? "cm");
  if (!unit) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const cm = widthCmOf({ value, unit });
  if (cm < 1 || cm > MAX_REASONABLE_CM) return null;
  return { value, unit };
}

/**
 * 从库里的一对「数值列 + 单位列」还原成度量。
 *
 * 单位列是 varchar：直写脏数据时不把非法单位当成合法单位返回，
 * 宁可读成「未填」也不要显示一个看起来没问题的错值。
 */
export function weightMeasurementFrom(
  value: number | null | undefined,
  unit: string | null | undefined,
): WeightMeasurement | null {
  if (value === null || value === undefined) return null;
  const parsed = WeightUnit.safeParse(unit);
  if (!parsed.success) return null;
  return { value, unit: parsed.data };
}

/** 门幅版的还原。 */
export function widthMeasurementFrom(
  value: number | null | undefined,
  unit: string | null | undefined,
): WidthMeasurement | null {
  if (value === null || value === undefined) return null;
  const parsed = WidthUnit.safeParse(unit);
  if (!parsed.success) return null;
  return { value, unit: parsed.data };
}

/**
 * 租户默认度量单位。
 * 只作用于**之后的录入默认值**：新建/编辑样品的单位下拉默认选中它，
 * 改公司默认值不会把已经录好的样品单位改掉（每条样品自带单位）。
 */
export const MeasureUnits = z
  .object({
    weight: WeightUnit,
    width: WidthUnit,
  })
  .strict();
export type MeasureUnits = z.infer<typeof MeasureUnits>;

/** 未配置时的默认：国内面料最常见的 g/m² 与 cm。 */
export const DEFAULT_MEASURE_UNITS: MeasureUnits = { weight: "gsm", width: "cm" };

/** 改默认单位：两个键都可单独提交，没提交的保持原值。 */
export const UpdateMeasureUnitsInput = z
  .object({
    weight: WeightUnit.optional(),
    width: WidthUnit.optional(),
  })
  .strict()
  .refine((value) => value.weight !== undefined || value.width !== undefined, {
    message: "至少需要修改一个默认单位",
  });
export type UpdateMeasureUnitsInput = z.infer<typeof UpdateMeasureUnitsInput>;
