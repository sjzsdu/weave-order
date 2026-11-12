import { HttpException } from "@nestjs/common";
import { CreateCustomerInput, CreateSampleInput } from "@weave-order/schema";
import { describe, expect, it } from "vitest";
import { trimTextFields } from "../src/kernel/normalize";
import { KernelError } from "../src/kernel";
import { invalidInputException, kernelErrorException, writeException } from "../src/http/errors";

interface ErrorBody {
  ok: false;
  error: { code: string; message: string; issues?: { path: (string | number)[] }[] };
}

function bodyOf(exception: HttpException): ErrorBody {
  return exception.getResponse() as ErrorBody;
}

/** 把一次 Zod 校验失败包装成和控制器一致的异常，验证「可读原因 + 400」。 */
function validationException(input: unknown, entity: string): HttpException {
  const parsed = CreateCustomerInput.safeParse(input);
  const error = parsed.success ? null : parsed.error;
  const exception = invalidInputException(error, entity);
  if (!exception) throw new Error("期望是校验错误");
  return exception;
}

describe("基础资料录入 · 可读错误（纯单测）", () => {
  it("客户名称为空：400 + 「名称必填」，而不是 500", () => {
    const exception = validationException({ code: "CUS-1", name: "" }, "客户");
    expect(exception.getStatus()).toBe(400);
    const body = bodyOf(exception);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toContain("名称必填");
    expect(body.error.issues?.[0]?.path).toEqual(["name"]);
  });

  it("客户名称缺失（undefined）：同样落到「必填」", () => {
    const exception = validationException({ code: "CUS-2" }, "客户");
    expect(bodyOf(exception).error.message).toContain("名称必填");
  });

  it("样品单位不合法：400 + 列出可选单位", () => {
    const parsed = CreateSampleInput.safeParse({ code: "SMP-1", name: "面料", unit: "斤" });
    const exception = invalidInputException(parsed.success ? null : parsed.error, "样品");
    expect(exception?.getStatus()).toBe(400);
    const message = bodyOf(exception!).error.message;
    expect(message).toContain("计量单位不合法");
    expect(message).toContain("meter");
    expect(message).toContain("piece");
  });

  it("客户重名：内核拒绝映射成 409，并保留可读中文原因", () => {
    const exception = kernelErrorException(
      new KernelError("KERNEL_REJECTED", "客户名称已存在：杭州织造有限公司", {
        reason: "CUSTOMER_NAME_EXISTS",
      }),
    );
    expect(exception?.getStatus()).toBe(409);
    const body = bodyOf(exception!);
    expect(body.error.code).toBe("CUSTOMER_NAME_EXISTS");
    expect(body.error.message).toContain("客户名称已存在");
  });

  it("编号重复：内核唯一约束拒绝同样映射成 409", () => {
    const exception = kernelErrorException(
      new KernelError("KERNEL_REJECTED", "客户编号已存在：CUS-1", {
        reason: "CUSTOMER_CODE_EXISTS",
      }),
    );
    expect(exception?.getStatus()).toBe(409);
  });

  it("未知异常不被伪装成 400：原样抛出交给 Nest 记录", () => {
    const boom = new Error("数据库连接断了");
    expect(kernelErrorException(boom)).toBeNull();
    expect(invalidInputException(boom, "客户")).toBeNull();
    expect(() => writeException(boom, "客户")).toThrow("数据库连接断了");
  });

  it("文本字段先 trim 再校验，避免全空格通过 min(1)", () => {
    expect(trimTextFields({ name: "  杭州织造  " }, ["name"])).toEqual({ name: "杭州织造" });
    const trimmed = trimTextFields({ code: " CUS-9 ", name: "   " }, ["code", "name"]);
    const parsed = CreateCustomerInput.safeParse(trimmed);
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues[0]?.path).toEqual(["name"]);
  });
});
