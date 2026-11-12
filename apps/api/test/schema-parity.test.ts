import { describe, expect, it } from "vitest";
import {
  Currency,
  CustomerTier,
  QuoteStatus,
  SampleShipmentStatus,
  TokenScope,
  Unit,
} from "@weave-order/schema";
import {
  actorTypeEnum,
  currencyEnum,
  customerTierEnum,
  deviceAuthStatusEnum,
  quoteStatusEnum,
  shipmentStatusEnum,
  tokenScopeEnum,
  unitEnum,
} from "@weave-order/db";

/**
 * 物理枚举（PostgreSQL）与契约枚举（Zod）必须完全一致，
 * 否则会出现「契约接受、写库失败」这类只在线上才炸的问题。
 */
describe("数据库枚举与契约枚举一致", () => {
  it("客户等级", () => {
    expect(customerTierEnum.enumValues).toEqual(CustomerTier.options);
  });

  it("币种", () => {
    expect(currencyEnum.enumValues).toEqual(Currency.options);
  });

  it("计量单位", () => {
    expect(unitEnum.enumValues).toEqual(Unit.options);
  });

  it("寄样单状态", () => {
    expect(shipmentStatusEnum.enumValues).toEqual(SampleShipmentStatus.options);
  });

  it("报价单状态", () => {
    expect(quoteStatusEnum.enumValues).toEqual(QuoteStatus.options);
  });

  it("审计 actor 类型", () => {
    expect(actorTypeEnum.enumValues).toEqual(["AGENT", "HUMAN", "SYSTEM"]);
  });

  it("凭据作用域", () => {
    expect(tokenScopeEnum.enumValues).toEqual(TokenScope.options);
  });

  it("设备登录状态", () => {
    expect(deviceAuthStatusEnum.enumValues).toEqual(["PENDING", "APPROVED", "CONSUMED", "DENIED"]);
  });
});
