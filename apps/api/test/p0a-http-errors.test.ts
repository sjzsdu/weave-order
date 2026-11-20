import { NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { rethrowHttp } from "../src/http/controllers";
import { KernelError } from "../src/kernel";

/**
 * 跨租户读取的 HTTP 语义：租户内查不到 = 404，不泄露「存在但无权」。
 * 内核已经按 tenant 过滤（见 p0a-kernel.integration），这里锁住错误映射，
 * 避免后续有人把 RESOURCE_NOT_FOUND 改成 400/500。
 */
describe("P0a HTTP 错误映射", () => {
  it("事项不存在映射为 404", () => {
    expect(() =>
      rethrowHttp(
        new KernelError("RESOURCE_NOT_FOUND", "事项不存在：x", {
          resourceType: "item",
          resourceId: "x",
        }),
      ),
    ).toThrow(NotFoundException);
  });

  it("客户不存在映射为 404", () => {
    expect(() =>
      rethrowHttp(new KernelError("CUSTOMER_NOT_FOUND", "客户不存在：x", { customerId: "x" })),
    ).toThrow(NotFoundException);
  });
});
