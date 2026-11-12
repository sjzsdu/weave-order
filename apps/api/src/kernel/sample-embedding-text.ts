/** 用于生成样品文本向量的字段组合（确定性、可复现）。 */
export function sampleEmbeddingText(sample: {
  code: string;
  name: string;
  composition: string | null;
  category?: string | null;
  weight: string | null;
}): string {
  return [
    sample.code,
    sample.name,
    sample.composition ?? "",
    sample.category ?? "",
    sample.weight ?? "",
  ]
    .join(" ")
    .trim();
}
