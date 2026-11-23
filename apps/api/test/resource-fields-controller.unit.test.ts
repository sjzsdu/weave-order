import { describe, expect, it, vi } from "vitest";
import type { ResourceFieldView } from "@weave-order/schema";
import { ResourceController } from "../src/http/resources.controllers";
import type { HumanActorService } from "../src/http/human-actor.service";
import type { Kernel, KernelContext } from "../src/kernel";

const RESOURCE_ID = "123e4567-e89b-12d3-a456-426614174002";
const CTX = { actor: { type: "HUMAN", id: "owner" } } as KernelContext;

function field(status: ResourceFieldView["status"]): ResourceFieldView {
  return {
    fieldName: "name",
    value: "32S 精梳棉汗布",
    status,
    sourceKind: "manual",
    sourceId: null,
    updatedAt: "2026-11-21T00:00:00.000Z",
    candidates: [],
  };
}

function controller(status: ResourceFieldView["status"]) {
  const updateFields = vi.fn().mockResolvedValue([field("CONFIRMED")]);
  const resourceOverview = vi.fn().mockResolvedValue({ generatedAt: "2026-11-22T00:00:00.000Z" });
  const scopes: Array<string | undefined> = [];
  const kernel = {
    resourceFields: {
      updateFields,
      list: vi.fn().mockResolvedValue([field(status)]),
    },
    workbench: { resourceOverview },
    samples: {
      getById: vi.fn().mockResolvedValue({ id: RESOURCE_ID, status: "DRAFT" }),
    },
    customers: {
      getById: vi.fn().mockResolvedValue({ id: RESOURCE_ID, status: "DRAFT" }),
    },
  } as unknown as Kernel;
  const human = {
    run: <T>(
      _auth: string | undefined,
      _kernel: Kernel,
      fn: (k: Kernel, c: KernelContext) => Promise<T>,
      options?: { scope: "read" | "write" },
    ) => {
      scopes.push(options?.scope);
      return fn(kernel, CTX);
    },
  } as unknown as HumanActorService;
  return {
    controller: new ResourceController(kernel, human),
    updateFields,
    resourceOverview,
    scopes,
  };
}

/**
 * 回归：逐字段确认的响应必须和 GET /fields 同形。
 * 客户端按 ResourceFieldsResponse 解析，只回 { fields } 会直出 Zod JSON（WAN-202）。
 */
describe("资源字段确认 HTTP 契约", () => {
  it("PATCH /samples/:id/fields 返回完整读模型", async () => {
    const { controller: resource } = controller("CONFIRMED");
    const body = { fields: [{ fieldName: "name", value: "32S 精梳棉汗布" }] };

    const result = await resource.updateSampleFields(RESOURCE_ID, body, undefined);

    expect(result).toEqual({
      resourceType: "sample",
      resourceId: RESOURCE_ID,
      resourceStatus: "DRAFT",
      fields: [field("CONFIRMED")],
      pendingCount: 0,
    });
  });

  it("PATCH /customers/:id/fields 也返回完整读模型", async () => {
    const { controller: resource } = controller("PENDING");
    const body = { fields: [{ fieldName: "name", value: "杭州织造" }] };

    const result = await resource.updateCustomerFields(RESOURCE_ID, body, undefined);

    expect(result.resourceType).toBe("customer");
    expect(result.pendingCount).toBe(1);
  });

  it("GET /resources/overview 在读上下文调用资源聚合", async () => {
    const { controller: resource, resourceOverview, scopes } = controller("CONFIRMED");

    const result = await resource.overview("Bearer token");

    expect(result).toEqual({ generatedAt: "2026-11-22T00:00:00.000Z" });
    expect(resourceOverview).toHaveBeenCalledWith(CTX);
    expect(scopes).toEqual(["read"]);
  });
});
