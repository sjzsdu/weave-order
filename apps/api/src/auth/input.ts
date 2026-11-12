import { HttpException } from "@nestjs/common";
import type { ZodTypeAny } from "zod";
import type { z } from "zod";

/** 把 Zod 校验失败映射成稳定的 400 错误体，与工具层的 INVALID_INPUT 语义对齐。 */
export function parseInput<T extends ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path,
      code: issue.code,
      message: issue.message,
    }));
    throw new HttpException(
      { error: { code: "INVALID_INPUT", message: "请求参数不合法", issues } },
      400,
    );
  }
  return result.data as z.output<T>;
}
