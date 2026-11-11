import type { Kernel } from "../kernel";
import {
  createCreateSampleShipmentTool,
  type CreateSampleShipmentTool,
} from "./create-sample-shipment.tool";
import {
  createGenerateQuoteDraftTool,
  type GenerateQuoteDraftTool,
} from "./generate-quote-draft.tool";
import {
  createGetCustomerHistoryTool,
  type GetCustomerHistoryTool,
} from "./get-customer-history.tool";

export interface Tools {
  getCustomerHistory: GetCustomerHistoryTool;
  generateQuoteDraft: GenerateQuoteDraftTool;
  createSampleShipment: CreateSampleShipmentTool;
}

/** 智能体可见的全部工具：只依赖 Kernel 的公开方法，不依赖数据库。 */
export function createTools(kernel: Kernel): Tools {
  return {
    getCustomerHistory: createGetCustomerHistoryTool(kernel),
    generateQuoteDraft: createGenerateQuoteDraftTool(kernel),
    createSampleShipment: createCreateSampleShipmentTool(kernel),
  };
}
