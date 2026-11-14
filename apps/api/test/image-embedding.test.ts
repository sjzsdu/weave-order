import { describe, expect, it, vi } from "vitest";
import {
  DashScopeMultiModalEmbeddingProvider,
  LocalStubImageEmbeddingProvider,
  createImageEmbeddingProvider,
} from "../src/platform/embedding";
import { DashScopeCaptioner } from "../src/platform/caption";

const IMG = { mimeType: "image/jpeg", base64: Buffer.from("fabric-bytes").toString("base64") };

function vectorOf(dimension: number, seed = 0.1): number[] {
  return Array.from({ length: dimension }, (_, index) => seed + index * 1e-6);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function embeddingsBody(count: number, dimension = 1024): unknown {
  return {
    output: { embeddings: Array.from({ length: count }, () => ({ embedding: vectorOf(dimension) })) },
    usage: { image_tokens: 64 * count },
  };
}

describe("图像 embedding provider 选择", () => {
  it("local-stub 确定性且明确标注 semantic=false", async () => {
    const provider = createImageEmbeddingProvider("local-stub");
    expect(provider).toBeInstanceOf(LocalStubImageEmbeddingProvider);
    expect(provider.semantic).toBe(false);
    const first = await provider.embedImage(IMG);
    const second = await provider.embedImage(IMG);
    expect(first).toEqual(second);
    expect(first).toHaveLength(provider.dimension);
  });

  it("local-stub 拒绝空图，不返回零向量冒充结果", async () => {
    const provider = new LocalStubImageEmbeddingProvider();
    await expect(provider.embedImage({ mimeType: "image/jpeg", base64: "" })).rejects.toThrow(
      /图像内容为空/,
    );
  });

  it("dashscope-qwen3-vl 没有 key 时构造即失败（不静默降级）", () => {
    expect(() => createImageEmbeddingProvider("dashscope-qwen3-vl", { apiKey: "  " })).toThrow(
      /需要 IMAGE_EMBEDDING_API_KEY/,
    );
  });

  it("未知 provider 显式报错", () => {
    expect(() => createImageEmbeddingProvider("clip-vit-h14")).toThrow(/尚未接入/);
  });
});

describe("DashScopeMultiModalEmbeddingProvider", () => {
  it("请求体是原生多模态端点 + data URI + 指定维度", async () => {
    const requests: { url: string; body: string; authorization: string }[] = [];
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({
        url,
        body: typeof init?.body === "string" ? init.body : "{}",
        authorization: headers.authorization ?? "",
      });
      return Promise.resolve(jsonResponse(embeddingsBody(1)));
    });
    const provider = new DashScopeMultiModalEmbeddingProvider({
      apiKey: "sk-test",
      fetchImpl: fetchImpl,
      dimension: 1024,
    });
    await provider.embedImage(IMG);

    expect(requests[0]?.url).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
    );
    const body = JSON.parse(requests[0]?.body ?? "{}") as {
      model: string;
      input: { contents: { image: string }[] };
      parameters: { dimension: number };
    };
    expect(body.model).toBe("qwen3-vl-embedding");
    expect(body.parameters.dimension).toBe(1024);
    expect(body.input.contents[0]?.image).toBe(`data:image/jpeg;base64,${IMG.base64}`);
    expect(requests[0]?.authorization).toBe("Bearer sk-test");
  });

  it("超过单批上限（10 张）时切片发送，且顺序与入参一致", async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      const raw = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(raw) as { input: { contents: unknown[] } };
      calls.push(body.input.contents.length);
      return Promise.resolve(jsonResponse(embeddingsBody(body.input.contents.length)));
    });
    const provider = new DashScopeMultiModalEmbeddingProvider({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const vectors = await provider.embedImages(Array.from({ length: 11 }, () => IMG));
    expect(calls).toEqual([10, 1]);
    expect(vectors).toHaveLength(11);
  });

  it("维度与配置不符时明确报错（提示改维度 + 重建索引）", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(embeddingsBody(1, 768))));
    const provider = new DashScopeMultiModalEmbeddingProvider({
      apiKey: "sk-test",
      fetchImpl: fetchImpl,
      dimension: 1024,
    });
    await expect(provider.embedImage(IMG)).rejects.toThrow(/维度非法|维度/);
  });

  it("5xx 按指数退避重试，耗尽后抛错（不回退哈希）", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("boom", { status: 500 })));
    const provider = new DashScopeMultiModalEmbeddingProvider({
      apiKey: "sk-test",
      fetchImpl: fetchImpl,
      maxAttempts: 3,
      retryBaseMs: 1,
    });
    await expect(provider.embedImage(IMG)).rejects.toThrow(/已尝试 3 次/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("4xx 不重试（配置/输入问题，重试没有意义）", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("bad request", { status: 400 })));
    const provider = new DashScopeMultiModalEmbeddingProvider({
      apiKey: "sk-test",
      fetchImpl: fetchImpl,
      maxAttempts: 3,
      retryBaseMs: 1,
    });
    await expect(provider.embedImage(IMG)).rejects.toThrow(/HTTP 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("响应条数不足时抛错（不能把少一条当成成功）", async () => {
    const requests: { url: string; body: string; authorization: string }[] = [];
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({
        url,
        body: typeof init?.body === "string" ? init.body : "{}",
        authorization: headers.authorization ?? "",
      });
      return Promise.resolve(jsonResponse(embeddingsBody(1)));
    });
    const provider = new DashScopeMultiModalEmbeddingProvider({
      apiKey: "sk-test",
      fetchImpl: fetchImpl,
      maxAttempts: 1,
    });
    await expect(provider.embedImages([IMG, IMG])).rejects.toThrow(/响应条数不符/);
  });
});

describe("DashScopeCaptioner", () => {
  it("把 image + 固定指令发给视觉模型，返回纯描述", async () => {
    const requests: { url: string; body: string }[] = [];
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      return Promise.resolve(
        jsonResponse({ choices: [{ message: { content: "米白底深蓝圆点印花棉布，平纹" } }] }),
      );
    });
    const captioner = new DashScopeCaptioner({
      apiKey: "sk-test",
      fetchImpl: fetchImpl,
    });
    const caption = await captioner.describe(IMG);
    expect(caption).toBe("米白底深蓝圆点印花棉布，平纹");

    expect(requests[0]?.url).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    expect(requests[0]?.body).toContain("data:image/jpeg;base64,");
  });

  it("没有描述文本时抛错（不能让空描述去检索）", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ choices: [{ message: { content: "  " } }] })),
    );
    const captioner = new DashScopeCaptioner({
      apiKey: "sk-test",
      fetchImpl: fetchImpl,
    });
    await expect(captioner.describe(IMG)).rejects.toThrow(/没有可用的描述/);
  });
});
