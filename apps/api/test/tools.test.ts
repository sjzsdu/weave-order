import { describe, expect, it, vi } from "vitest";
import type { Kernel } from "../src/kernel";
import { createGenerateQuoteDraftTool } from "../src/tools/generate-quote-draft.tool";
import { createGetCustomerHistoryTool } from "../src/tools/get-customer-history.tool";
import { createSearchFabricByImageTool } from "../src/tools/search-fabric-by-image.tool";
import type { ImageFetcher } from "../src/platform/media";
import type { KernelContext } from "../src/kernel";

const AGENT: KernelContext = { actor: { type: "AGENT", id: "test-agent" } };

/** 这些用例只走输入校验分支，不应触达内核；用空内核即可。 */
const unusedKernel = {} as Kernel;

describe("工具层：输入校验与失败语义封闭", () => {
  it("T-003 非 UUID 输入 -> INVALID_INPUT（不是 INTERNAL）", async () => {
    const tool = createGetCustomerHistoryTool(unusedKernel);
    const result = await tool.execute({ customerId: "not-a-uuid" }, AGENT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("T-003 未知字段被拒绝（.strict()，智能体不能夹带账本字段）", async () => {
    const tool = createGetCustomerHistoryTool(unusedKernel);
    const result = await tool.execute(
      {
        customerId: "123e4567-e89b-12d3-a456-426614174000",
        decisionDeltas: [],
      },
      AGENT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("T-004 浮点金额 -> INVALID_INPUT（金额必须是整数分）", async () => {
    const tool = createGenerateQuoteDraftTool(unusedKernel);
    const result = await tool.execute(
      {
        customerId: "123e4567-e89b-12d3-a456-426614174000",
        currency: "CNY",
        items: [
          {
            fabricSampleId: "123e4567-e89b-12d3-a456-426614174001",
            quantity: { value: 10, unit: "meter" },
            unitPrice: { amount: 10.5, currency: "CNY" },
          },
        ],
      },
      AGENT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
      if (result.error.code === "INVALID_INPUT") {
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    }
  });

  it("T-001 imageUrl：先白名单取图，再走同一条 embedding 检索", async () => {
    const searchByImage = vi.fn(() =>
      Promise.resolve({
        embeddingModel: "local-stub-v1",
        dimension: 16,
        matches: [],
      }),
    );
    const kernel = { search: { searchByImage } } as unknown as Kernel;
    const fetchImage = vi.fn(() =>
      Promise.resolve({
        mimeType: "image/jpeg" as const,
        base64: "ZmV0Y2hlZA==",
      }),
    );
    const fetcher: ImageFetcher = { fetchImage };
    const tool = createSearchFabricByImageTool(kernel, fetcher);

    const result = await tool.execute(
      { imageUrl: "https://cdn.weaveorder.cn/fabric/a.jpg" },
      AGENT,
    );
    expect(result.ok).toBe(true);
    expect(fetchImage).toHaveBeenCalledWith("https://cdn.weaveorder.cn/fabric/a.jpg");
    expect(searchByImage).toHaveBeenCalledWith(
      { mimeType: "image/jpeg", base64: "ZmV0Y2hlZA==" },
      5,
      // S4 起默认阈值是 0.75（实测异款余弦可到 0.69）；0.55 会把不同面料放进来。
      0.75,
    );
  });

  it("T-001 base64 兼容路径不触达取图器", async () => {
    const searchByImage = vi.fn(() =>
      Promise.resolve({
        embeddingModel: "local-stub-v1",
        dimension: 16,
        matches: [],
      }),
    );
    const kernel = { search: { searchByImage } } as unknown as Kernel;
    const fetchImage = vi.fn();
    const tool = createSearchFabricByImageTool(kernel, { fetchImage });
    const result = await tool.execute(
      { image: { mimeType: "image/png", base64: "aGVsbG8=" } },
      AGENT,
    );
    expect(result.ok).toBe(true);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("T-001 取图失败 -> UPSTREAM_UNAVAILABLE（不是 INTERNAL）", async () => {
    const kernel = { search: { searchByImage: vi.fn() } } as unknown as Kernel;
    const tool = createSearchFabricByImageTool(kernel, {
      fetchImage: () => Promise.reject(new Error("主机不在白名单")),
    });
    const result = await tool.execute({ imageUrl: "https://evil.example.com/a.jpg" }, AGENT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UPSTREAM_UNAVAILABLE");
      if (result.error.code === "UPSTREAM_UNAVAILABLE") {
        expect(result.error.dependency).toBe("object_storage");
      }
    }
  });
});
