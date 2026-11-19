import { T007GetFieldOptionsInput, T007GetFieldOptionsResult } from "@weave-order/schema";
import type { T007GetFieldOptionsResult as Result } from "@weave-order/schema";
import type { Kernel, KernelContext } from "../kernel";
import { invalidInput, toToolError } from "./errors";

/**
 * T-007 get_field_options。
 *
 * 智能体只拿到选项与解析结果，不能直接写 `field_options`：新值由人在审批流里决定
 * 是否存为选项。这与「智能体起草、人类批准」的既有模式一致。
 */
export function createGetFieldOptionsTool(kernel: Kernel) {
  return {
    id: "T-007",
    name: "get_field_options",
    inputSchema: T007GetFieldOptionsInput,
    async execute(input: unknown, _ctx: KernelContext): Promise<Result> {
      const parsed = T007GetFieldOptionsInput.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: invalidInput(parsed.error) };
      }
      try {
        const options = await kernel.fieldOptions.list(parsed.data.fieldKey, false);
        const resolution = parsed.data.value
          ? await kernel.fieldOptions.resolve(parsed.data.fieldKey, parsed.data.value, true)
          : null;
        return T007GetFieldOptionsResult.parse({
          ok: true,
          data: {
            options,
            resolution: resolution
              ? {
                  fieldKey: resolution.fieldKey,
                  input: resolution.input,
                  normalized: resolution.normalized,
                  matched: resolution.matched,
                  code: resolution.code,
                  label: resolution.label,
                }
              : null,
          },
        });
      } catch (error) {
        return T007GetFieldOptionsResult.parse({ ok: false, error: toToolError(error) });
      }
    },
  };
}

export type GetFieldOptionsTool = ReturnType<typeof createGetFieldOptionsTool>;
export type { KernelContext };
