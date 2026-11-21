/** 用于生成样品文本向量的字段组合（确定性、可复现）。 */
export function sampleEmbeddingText(sample: {
  code: string;
  name: string;
  composition: string | null;
  category?: string | null;
  color?: string | null;
  weight: string | null;
}): string {
  return [
    sample.code,
    sample.name,
    sample.composition ?? "",
    sample.category ?? "",
    // 颜色按「有值才加入」拼：升级后没有颜色的样品文本保持不变，
    // 不会仅为了多一个空槽触发全量重嵌入。
    ...(sample.color ? [sample.color] : []),
    sample.weight ?? "",
  ]
    .join(" ")
    .trim();
}
