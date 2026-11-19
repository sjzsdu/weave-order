import { z } from "zod";
import { toolResultSchema } from "../common";
import { FieldKey, FieldOption, ResolveFieldValueResponse } from "../field-options";

/**
 * T-007 get_field_options：智能体读取公司字典并解析一个候选值。
 *
 * 智能体不能自己发明等级：`customer.tier` 的写入必须以 `resolution.matched = true`
 * 为前提；未命中时 `code` 为 null，草稿要标「新等级待确认」交给人工落成选项。
 */
export const T007GetFieldOptionsInput = z
  .object({
    fieldKey: FieldKey,
    /** 可选：要解析的候选值，命中返回稳定 code。 */
    value: z.string().max(128).optional(),
  })
  .strict();
export type T007GetFieldOptionsInput = z.infer<typeof T007GetFieldOptionsInput>;

export const T007GetFieldOptionsData = z
  .object({
    /** 当前启用中的选项，按公司排序返回。 */
    options: z.array(FieldOption),
    resolution: ResolveFieldValueResponse.nullable(),
  })
  .strict();
export type T007GetFieldOptionsData = z.infer<typeof T007GetFieldOptionsData>;

export const T007GetFieldOptionsResult = toolResultSchema(T007GetFieldOptionsData);
export type T007GetFieldOptionsResult = z.infer<typeof T007GetFieldOptionsResult>;
