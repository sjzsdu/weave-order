import { describe, expect, it } from "vitest";
import {
  DashScopeTextEmbeddingProvider,
  LocalStubEmbeddingProvider,
  createEmbeddingProvider,
} from "../src/platform/embedding";

describe("local stub embedding provider", () => {
  const provider = new LocalStubEmbeddingProvider();

  it("输出固定维度且 L2 归一化", async () => {
    const vector = await provider.embedText("高支棉 220g/m2");
    expect(vector).toHaveLength(provider.dimension);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("同一输入确定复现，不同输入不同", async () => {
    const a = await provider.embedText("高支棉");
    const b = await provider.embedText("高支棉");
    const c = await provider.embedText("涤纶");
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("图像输入同样确定复现", async () => {
    const image = { mimeType: "image/jpeg", base64: "aGVsbG8td2VhdmU=" };
    expect(await provider.embedImage(image)).toEqual(await provider.embedImage(image));
  });

  it("空文本 / 非法 base64 被拒绝", async () => {
    await expect(provider.embedText("   ")).rejects.toThrow(/非空文本/);
    await expect(provider.embedImage({ mimeType: "image/png", base64: "!!!!" })).rejects.toThrow(
      /base64 非法|内容为空/,
    );
  });

  it("通过工厂创建；未知 provider 显式报错而不是静默降级", () => {
    expect(createEmbeddingProvider("local-stub").name).toBe("local-stub-v1");
    expect(() => createEmbeddingProvider("openai")).toThrow(/尚未接入/);
  });
});

const DIM = 4;

function vectorOf(text: string): number[] {
  return Array.from({ length: DIM }, (_, index) => text.length + index + 1);
}

function jsonResponse(vectors: number[][], status = 200): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ embedding, index })),
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function provider(fetchImpl: typeof fetch, overrides: Partial<DashScopeEmbeddingOptionsLike> = {}) {
  return new DashScopeTextEmbeddingProvider({
    apiKey: "test-key",
    dimension: DIM,
    model: "text-embedding-v3",
    maxAttempts: 3,
    retryBaseMs: 0,
    fetchImpl,
    ...overrides,
  });
}

type DashScopeEmbeddingOptionsLike = ConstructorParameters<
  typeof DashScopeTextEmbeddingProvider
>[0];

describe("DashScope text-embedding-v3 provider", () => {
  it("批量按 10 条切片，返回顺序与入参一致", async () => {
    const batches: string[][] = [];
    const stub: typeof fetch = (_input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(raw) as { input: string[] };
      batches.push(body.input);
      return Promise.resolve(jsonResponse(body.input.map(vectorOf)));
    };
    const texts = Array.from({ length: 25 }, (_, index) => `面料 ${index}`);
    const vectors = await provider(stub).embedTexts(texts);

    expect(batches.map((batch) => batch.length)).toEqual([10, 10, 5]);
    expect(vectors).toHaveLength(25);
    expect(vectors[10]).toEqual(vectorOf(texts[10]!));
  });

  it("5xx 指数退避重试后成功", async () => {
    let calls = 0;
    const stub: typeof fetch = () => {
      calls += 1;
      if (calls < 3) {
        return Promise.resolve(
          new Response("upstream boom", { status: 503, statusText: "Service Unavailable" }),
        );
      }
      return Promise.resolve(jsonResponse([vectorOf("ok")]));
    };
    await expect(provider(stub).embedText("ok")).resolves.toEqual(vectorOf("ok"));
    expect(calls).toBe(3);
  });

  it("4xx 是配置/输入错误，不重试且抛错", async () => {
    let calls = 0;
    const stub: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(new Response("bad key", { status: 401, statusText: "Unauthorized" }));
    };
    await expect(provider(stub).embedText("x")).rejects.toThrow(/HTTP 401/);
    expect(calls).toBe(1);
  });

  it("超时重试耗尽后明确报错（不回退哈希）", async () => {
    let calls = 0;
    const stub: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        calls += 1;
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    await expect(provider(stub, { timeoutMs: 5, maxAttempts: 2 }).embedText("x")).rejects.toThrow(
      /请求超时（5ms）/,
    );
    expect(calls).toBe(2);
  });

  it("维度不符 / 条数不足都抛错", async () => {
    const wrongDimension: typeof fetch = () => Promise.resolve(jsonResponse([[1, 2, 3]]));
    await expect(provider(wrongDimension).embedText("x")).rejects.toThrow(/维度非法/);
    const missing: typeof fetch = () => Promise.resolve(jsonResponse([]));
    await expect(provider(missing).embedText("x")).rejects.toThrow(/响应条数不符/);
  });

  it("文本模型不提供图像向量，且缺 key 时构造即失败", async () => {
    const noop: typeof fetch = () => Promise.resolve(jsonResponse([vectorOf("x")]));
    await expect(
      provider(noop).embedImage({ mimeType: "image/jpeg", base64: "aGVsbG8=" }),
    ).rejects.toThrow(/只支持文本/);
    expect(() => createEmbeddingProvider("dashscope-text-v3")).toThrow(/EMBEDDING_API_KEY/);
  });

  it("工厂注册 dashscope-text-v3 且保留 local-stub 默认", () => {
    expect(createEmbeddingProvider().name).toBe("local-stub-v1");
    const built = createEmbeddingProvider("dashscope-text-v3", { apiKey: "k", dimension: 1024 });
    expect(built.name).toBe("dashscope-text-embedding-v3");
    expect(built.dimension).toBe(1024);
    expect(built.semantic).toBe(true);
  });
});
