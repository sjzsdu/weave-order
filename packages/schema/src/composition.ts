import { z } from "zod";

/**
 * 成分配比：原料 + 百分比。
 *
 * 成分今天是一段自由文本（`samples.composition`），打印、样卡、报价都用它。
 * 配比模式要把「棉 55 / 麻 45」这种结构单独存下来，理由有两个：
 * - 文本是**派生**：配比一旦成立，成分串由代码算，客户端写死文本会出现两份口径；
 * - 结构化才有后续价值（哪些样品含氨纶、棉含量占比），那是文本给不了的。
 *
 * 但文本列不删：它是印在样卡和报价单上的原文，样卡模板、检索分面、导入都吃它。
 * 于是两条路互斥：
 * - **文本模式** → 只写 `composition` 原文，配比列为空；
 * - **配比模式** → 只写配比，服务端派生 `composition`。
 *
 * 原料身份用 `code`（租户级「样品原料」字典里的稳定标识），`label` 是落库时的快照：
 * 选项改名不影响历史记录 —— 与品类/颜色「业务表存原文、选项只是建议」同一原则。
 */

/** 一项原料的配比（落库形态：带 label 快照）。 */
export const CompositionPart = z
  .object({
    /** 原料选项 code：稳定标识，改名/合并都靠它定位。 */
    code: z.string().min(1).max(64),
    /** 原料名快照：选项改名不改历史。 */
    label: z.string().min(1).max(64),
    /** 百分比：> 0，合计必须正好 100。 */
    percent: z.number().positive().max(100),
  })
  .strict();
export type CompositionPart = z.infer<typeof CompositionPart>;

/**
 * 配比输入形态：客户端只给 code 与百分比。
 *
 * `label` 允许带但不作数 —— 字段矩阵里存的是带名称快照的落库形态，
 * 逐字段确认页把它原样送回来时不该被判「形状不对」；
 * 真正的名称一律由服务端按字典取，客户端自造的名字进不了库。
 */
export const CompositionPartInput = z
  .object({
    code: z.string().min(1).max(64),
    label: z.string().min(1).max(64).optional(),
    percent: z.number().positive().max(100),
  })
  .strict();
export type CompositionPartInput = z.infer<typeof CompositionPartInput>;

/** 一份成分最多几项原料：超过就多半不是面料成分表。 */
export const COMPOSITION_MAX_PARTS = 10;

/** 合计百分比与 100 的容差：浮点累加会差最后一丁点。 */
const PERCENT_SUM_TOLERANCE = 0.01;

/**
 * 合计必须正好 100%。
 *
 * 为什么是硬门槛：成分标注是合规项，「55% 麻 45% 棉」缺一块就说明数据没录全。
 * 文本模式不受这条约束 —— 供应商表格里「棉涤」不带比例是常态，那是**原文**不是配比。
 */
function checkParts(
  parts: Array<{ code: string; percent: number }>,
  ctx: z.RefinementCtx,
): void {
  const sum = parts.reduce((acc, part) => acc + part.percent, 0);
  if (Math.abs(sum - 100) > PERCENT_SUM_TOLERANCE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `合计 ${compositionPercentText(sum)}%，必须正好 100%`,
    });
  }
  const codes = new Set(parts.map((part) => part.code));
  if (codes.size !== parts.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "同一原料不能出现两次，请把百分比合并",
    });
  }
}

/** 配比输入（客户端形状）。 */
export const CompositionPartsInput = z
  .array(CompositionPartInput)
  .min(1)
  .max(COMPOSITION_MAX_PARTS)
  .superRefine(checkParts);
export type CompositionPartsInput = z.infer<typeof CompositionPartsInput>;

/** 配比（落库/读模型形状）。 */
export const CompositionParts = z
  .array(CompositionPart)
  .min(1)
  .max(COMPOSITION_MAX_PARTS)
  .superRefine(checkParts);
export type CompositionParts = z.infer<typeof CompositionParts>;

/** 百分比显示：整数不带小数点，小数最多三位。 */
export function compositionPercentText(percent: number): string {
  return Number.isInteger(percent) ? String(percent) : String(Number(percent.toFixed(3)));
}

/**
 * 配比 → 成分文本。
 *
 * 排序按百分比降序 —— GB/T 29862 的标注习惯是从主要成分写到次要成分，
 * 让人一眼看出主要成分是什么。同百分比按名称排，保证同一份配比每次渲染一致。
 */
export function compositionText(parts: CompositionParts): string {
  return [...parts]
    .sort((a, b) => b.percent - a.percent || a.label.localeCompare(b.label, "zh-Hans-CN"))
    .map((part) => `${compositionPercentText(part.percent)}% ${part.label}`)
    .join(" ");
}

/**
 * 成分在字段出处矩阵里的取值。
 *
 * - 文本模式：原文字符串（OCR 抽出来的、用户手打的都是它）；
 * - 配比模式：`{ parts: [...] }`，服务端解析后回填 label 快照。
 */
export const CompositionFieldValue = z.union([
  z.string().max(255),
  z.object({ parts: CompositionPartsInput }).strict(),
]);
export type CompositionFieldValue = z.infer<typeof CompositionFieldValue>;

/**
 * 把一个原料并进另一个原料（原料选项合并时用）。
 *
 * 百分比**相加**而不是取其一：合并的是「同一个东西的两个名字」，
 * 比例必须守恒（合计仍是 100），否则成分标注就错了。
 * 目标原料若本来也在这份配比里，两项合并成一项。
 */
export function mergeCompositionParts(
  parts: CompositionParts,
  fromCode: string,
  to: { code: string; label: string },
): CompositionParts {
  const merged: CompositionPart[] = [];
  for (const part of parts) {
    if (part.code === fromCode) {
      const existing = merged.find((entry) => entry.code === to.code);
      if (existing) {
        existing.percent = Number((existing.percent + part.percent).toFixed(4));
      } else {
        merged.push({ code: to.code, label: to.label, percent: part.percent });
      }
      continue;
    }
    if (part.code === to.code) {
      const existing = merged.find((entry) => entry.code === to.code);
      if (existing) {
        existing.percent = Number((existing.percent + part.percent).toFixed(4));
      } else {
        merged.push({ code: to.code, label: to.label, percent: part.percent });
      }
      continue;
    }
    merged.push({ ...part });
  }
  return CompositionParts.parse(merged);
}
