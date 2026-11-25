import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { SAMPLE_SHIPMENT_LOOKUP_MAX_SAMPLE_IDS } from "@weave-order/schema";
import type { SampleShipmentRecord } from "@weave-order/schema";
import {
  SampleShipmentController,
  parseSampleShipmentSampleIds,
  parseSampleShipmentStatus,
} from "../src/http/sample-shipments.controllers";
import type { HumanActorService } from "../src/http/human-actor.service";
import type { Kernel, KernelContext } from "../src/kernel";

const SAMPLE_A = "11111111-1111-4111-8111-111111111111";
const SAMPLE_B = "22222222-2222-4222-8222-222222222222";
const CTX = { actor: { type: "HUMAN", id: "owner" } } as KernelContext;

function record(overrides: Partial<SampleShipmentRecord> = {}): SampleShipmentRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    code: "SS-0001",
    status: "DRAFT",
    carrier: "顺丰",
    trackingNumber: "SF123",
    customerId: "44444444-4444-4444-8444-444444444444",
    customerName: "天宝纺织",
    sampleIds: [SAMPLE_A],
    createdAt: "2026-11-20T02:00:00.000Z",
    confirmedAt: null,
    ...overrides,
  };
}

function controller(rows: SampleShipmentRecord[] = [record()]) {
  const listBySampleIds = vi.fn().mockResolvedValue(rows);
  const scopes: Array<string | undefined> = [];
  const kernel = { shipments: { listBySampleIds } } as unknown as Kernel;
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
  return { controller: new SampleShipmentController(kernel, human), listBySampleIds, scopes };
}

describe("GET /api/sample-shipments 参数", () => {
  it("逗号分隔的样品 id 去重后一次批发给内核，只开读作用域", async () => {
    const { controller: http, listBySampleIds, scopes } = controller();
    const result = await http.list(`${SAMPLE_A},${SAMPLE_B},${SAMPLE_A}`, undefined, undefined);
    expect(result).toEqual({ shipments: [record()] });
    expect(listBySampleIds).toHaveBeenCalledWith([SAMPLE_A, SAMPLE_B], CTX, undefined);
    expect(scopes).toEqual(["read"]);
  });

  it("status 透传；非法状态 400 且文案列出可取值", async () => {
    const { controller: http, listBySampleIds } = controller([]);
    await http.list(SAMPLE_A, "DELIVERED", undefined);
    expect(listBySampleIds).toHaveBeenCalledWith([SAMPLE_A], CTX, "DELIVERED");
    expect(() => parseSampleShipmentStatus("LOST")).toThrow(BadRequestException);
    expect(() => parseSampleShipmentStatus("LOST")).toThrow(/DRAFT.*CONFIRMED.*SHIPPED/);
  });

  it("超过上限 400，不静默截断", () => {
    const ids = Array.from(
      { length: SAMPLE_SHIPMENT_LOOKUP_MAX_SAMPLE_IDS + 1 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(() => parseSampleShipmentSampleIds(ids.join(","))).toThrow(BadRequestException);
    expect(() => parseSampleShipmentSampleIds(ids.join(","))).toThrow(
      `单次最多查询 ${SAMPLE_SHIPMENT_LOOKUP_MAX_SAMPLE_IDS} 个样品，当前 ${
        SAMPLE_SHIPMENT_LOOKUP_MAX_SAMPLE_IDS + 1
      } 个`,
    );
    // 恰好等于上限仍然放行。
    expect(parseSampleShipmentSampleIds(ids.slice(0, -1).join(","))).toHaveLength(
      SAMPLE_SHIPMENT_LOOKUP_MAX_SAMPLE_IDS,
    );
  });

  it("缺少 / 空值 / 非法 UUID / 重复参数一律 400", () => {
    expect(() => parseSampleShipmentSampleIds(undefined)).toThrow(/缺少 sampleIds/);
    expect(() => parseSampleShipmentSampleIds("   ")).toThrow(/缺少 sampleIds/);
    expect(() => parseSampleShipmentSampleIds(`${SAMPLE_A},,${SAMPLE_B}`)).toThrow(/空值/);
    expect(() => parseSampleShipmentSampleIds("not-a-uuid")).toThrow(/不是合法 UUID/);
    expect(() => parseSampleShipmentSampleIds([SAMPLE_A, SAMPLE_B])).toThrow(/只能出现一次/);
  });
});
