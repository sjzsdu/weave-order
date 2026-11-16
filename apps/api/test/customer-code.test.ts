import { describe, expect, it } from "vitest";
import { customerCodePrefix, formatCustomerCode } from "../src/kernel/customers.service";

describe("客户编号生成", () => {
  it("按北京时间生成 CYYMMDD- 前缀（UTC 16:00 已经跨日）", () => {
    expect(customerCodePrefix(new Date("2026-11-15T16:00:00.000Z"))).toBe("C261116-");
    expect(customerCodePrefix(new Date("2026-11-15T15:59:59.999Z"))).toBe("C261115-");
    expect(customerCodePrefix(new Date("2027-01-01T00:00:00.000Z"))).toBe("C270101-");
  });

  it("序号至少 4 位，超过 9999 自然进位", () => {
    expect(formatCustomerCode("C261116-", 1)).toBe("C261116-0001");
    expect(formatCustomerCode("C261116-", 42)).toBe("C261116-0042");
    expect(formatCustomerCode("C261116-", 10000)).toBe("C261116-10000");
  });
});
