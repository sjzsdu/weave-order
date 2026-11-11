import { T005CreateSampleShipmentInput, T005CreateSampleShipmentResult } from "@weave-order/schema";
import type { T005CreateSampleShipmentResult as Result } from "@weave-order/schema";
import type { Kernel, KernelContext } from "../kernel";
import { invalidInput, toToolError } from "./errors";

/** 跟进建议时间由内核时钟计算（3 天），不是 LLM 猜的。 */
const FOLLOWUP_DELAY_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * T-005 create_sample_shipment。
 * 内核强制产出 DRAFT；确认（DRAFT -> CONFIRMED）不在工具层暴露，
 * 只能由人类审批窗口调用内核 confirm。
 */
export function createCreateSampleShipmentTool(kernel: Kernel) {
  return {
    id: "T-005",
    name: "create_sample_shipment",
    inputSchema: T005CreateSampleShipmentInput,
    async execute(input: unknown, ctx: KernelContext): Promise<Result> {
      const parsed = T005CreateSampleShipmentInput.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: invalidInput(parsed.error) };
      }
      try {
        const shipment = await kernel.shipments.createDraft(parsed.data, ctx);
        const followupSuggestedAt = new Date(
          new Date(shipment.createdAt).getTime() + FOLLOWUP_DELAY_MS,
        ).toISOString();
        return T005CreateSampleShipmentResult.parse({
          ok: true,
          data: { shipment, followupSuggestedAt },
        });
      } catch (error) {
        return T005CreateSampleShipmentResult.parse({
          ok: false,
          error: toToolError(error),
        });
      }
    },
  };
}

export type CreateSampleShipmentTool = ReturnType<typeof createCreateSampleShipmentTool>;
