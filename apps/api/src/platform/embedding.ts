/**
 * Embedding provider 接口。
 *
 * 演示与 MVP 默认使用 local stub：不需要任何外部模型 key，输出确定性向量，
 * 因此测试与 `pnpm demo` 在任何机器上结果一致。
 * 真实 provider（OpenAI / 通义 / 自建）以后实现同一个接口注入即可，
 * 内核与工具层不需要改动。
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  embedText(text: string): Promise<number[]>;
  embedImage(image: { mimeType: string; base64: string }): Promise<number[]>;
}

/** 16 维本地 stub：FNV-1a 哈希散列到固定维度后做 L2 归一化。 */
const STUB_DIMENSION = 16;

function hashVector(bytes: Uint8Array): number[] {
  const vector: number[] = [];
  for (let i = 0; i < STUB_DIMENSION; i += 1) vector.push(0);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i] ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    vector[i % STUB_DIMENSION] = (vector[i % STUB_DIMENSION] ?? 0) + ((hash % 2001) - 1000) / 1000;
  }
  if (vector.every((value) => value === 0)) return [1, ...vector.slice(1)];
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

export class LocalStubEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local-stub-v1";
  readonly dimension = STUB_DIMENSION;

  embedText(text: string): Promise<number[]> {
    if (text.trim().length === 0) {
      return Promise.reject(new Error("embedText 需要非空文本"));
    }
    return Promise.resolve(hashVector(Buffer.from(text, "utf8")));
  }

  embedImage(image: { mimeType: string; base64: string }): Promise<number[]> {
    const bytes = Buffer.from(image.base64, "base64");
    if (bytes.length === 0) {
      return Promise.reject(new Error(`图像内容为空或 base64 非法（mimeType=${image.mimeType}）`));
    }
    // 把 mimeType 也纳入哈希，避免不同格式的同名文件算出完全无关的向量。
    return Promise.resolve(hashVector(Buffer.concat([Buffer.from(image.mimeType, "utf8"), bytes])));
  }
}

/**
 * 按配置创建 provider。
 * 目前只实现 local stub；真实 provider 尚未接入，显式报错而不是静默降级。
 */
export function createEmbeddingProvider(provider = "local-stub"): EmbeddingProvider {
  if (provider === "local-stub") return new LocalStubEmbeddingProvider();
  throw new Error(
    `EMBEDDING_PROVIDER=${provider} 尚未接入；当前支持：local-stub。真实 provider 请实现 EmbeddingProvider 接口后在此注册。`,
  );
}
