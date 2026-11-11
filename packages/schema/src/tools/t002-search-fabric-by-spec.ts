import { z } from "zod";
import { toolResultSchema } from "../common";
import { FabricSample } from "../domain";

/**
 * T-002 search_fabric_by_spec —— 找样智能体的参数匹配。
 *
 * 匹配规则是确定性的：关键词命中编号 / 品名 / 成分，可选成分过滤；
 * `matchedOn` 明确告诉调用方为什么这条结果相关，不编造理由。
 */
export const T002SearchFabricBySpecInput = z
  .object({
    query: z.string().min(1).max(200),
    /** 成分过滤，如 "棉" / "polyester" */
    composition: z.string().min(1).max(100).optional(),
    limit: z.number().int().positive().max(100).default(20),
  })
  .strict();
export type T002SearchFabricBySpecInput = z.infer<typeof T002SearchFabricBySpecInput>;

export const SpecMatch = z
  .object({
    sample: FabricSample,
    /** 命中字段占比，0..1 */
    score: z.number().min(0).max(1),
    /** 命中的字段名，如 ["code", "name"] */
    matchedOn: z.array(z.enum(["code", "name", "composition", "weight"])),
  })
  .strict();
export type SpecMatch = z.infer<typeof SpecMatch>;

export const T002SearchFabricBySpecData = z.object({ matches: z.array(SpecMatch) }).strict();
export type T002SearchFabricBySpecData = z.infer<typeof T002SearchFabricBySpecData>;

export const T002SearchFabricBySpecResult = toolResultSchema(T002SearchFabricBySpecData);
export type T002SearchFabricBySpecResult = z.infer<typeof T002SearchFabricBySpecResult>;
