import type { Kernel } from "../kernel";
import type { ImageFetcher } from "../platform/media";
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
import { createGetFieldOptionsTool, type GetFieldOptionsTool } from "./get-field-options.tool";
import {
  createSearchFabricByImageTool,
  type SearchFabricByImageTool,
} from "./search-fabric-by-image.tool";
import {
  createSearchFabricBySpecTool,
  type SearchFabricBySpecTool,
} from "./search-fabric-by-spec.tool";
import { createSuggestLinePriceTool, type SuggestLinePriceTool } from "./suggest-line-price.tool";

export interface Tools {
  searchFabricByImage: SearchFabricByImageTool;
  searchFabricBySpec: SearchFabricBySpecTool;
  getCustomerHistory: GetCustomerHistoryTool;
  getFieldOptions: GetFieldOptionsTool;
  generateQuoteDraft: GenerateQuoteDraftTool;
  suggestLinePrice: SuggestLinePriceTool;
  createSampleShipment: CreateSampleShipmentTool;
}

/** 智能体可见的全部工具：只依赖 Kernel 的公开方法，不依赖数据库。 */
export function createTools(kernel: Kernel, imageFetcher?: ImageFetcher): Tools {
  return {
    searchFabricByImage: createSearchFabricByImageTool(kernel, imageFetcher),
    searchFabricBySpec: createSearchFabricBySpecTool(kernel),
    getCustomerHistory: createGetCustomerHistoryTool(kernel),
    getFieldOptions: createGetFieldOptionsTool(kernel),
    generateQuoteDraft: createGenerateQuoteDraftTool(kernel),
    suggestLinePrice: createSuggestLinePriceTool(kernel),
    createSampleShipment: createCreateSampleShipmentTool(kernel),
  };
}
