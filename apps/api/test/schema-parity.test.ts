import { describe, expect, it } from "vitest";
import {
  Currency,
  CustomerTier,
  DataScope,
  IsolationMode,
  LlmScope,
  LlmTask,
  MemberRole,
  MembershipStatus,
  OrderStatus,
  QuoteStatus,
  QuoteShareEventType,
  ReceivableStatus,
  RevisionRequestStatus,
  RevisionSource,
  SampleShipmentStatus,
  ShipmentStatus,
  TenantStatus,
  TokenScope,
  Unit,
} from "@weave-order/schema";
import {
  actorTypeEnum,
  currencyEnum,
  customerTierEnum,
  dataScopeEnum,
  isolationModeEnum,
  deviceAuthStatusEnum,
  llmScopeEnum,
  llmTaskEnum,
  tokenScopeEnum,
  memberRoleEnum,
  membershipStatusEnum,
  orderShipmentStatusEnum,
  orderStatusEnum,
  quoteStatusEnum,
  quoteShareEventEnum,
  receivableStatusEnum,
  revisionRequestStatusEnum,
  revisionSourceEnum,
  shipmentStatusEnum,
  tenantStatusEnum,
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

  it("租户 / 成员", () => {
    expect(tenantStatusEnum.enumValues).toEqual(TenantStatus.options);
    expect(isolationModeEnum.enumValues).toEqual(IsolationMode.options);
    expect(memberRoleEnum.enumValues).toEqual(MemberRole.options);
    expect(dataScopeEnum.enumValues).toEqual(DataScope.options);
    expect(membershipStatusEnum.enumValues).toEqual(MembershipStatus.options);
  });

  it("订单 / 发货 / 应收", () => {
    expect(orderStatusEnum.enumValues).toEqual(OrderStatus.options);
    expect(orderShipmentStatusEnum.enumValues).toEqual(ShipmentStatus.options);
    expect(receivableStatusEnum.enumValues).toEqual(ReceivableStatus.options);
  });

  it("改稿 / 分享", () => {
    expect(revisionSourceEnum.enumValues).toEqual(RevisionSource.options);
    expect(revisionRequestStatusEnum.enumValues).toEqual(RevisionRequestStatus.options);
    expect(quoteShareEventEnum.enumValues).toEqual(QuoteShareEventType.options);
  });

  it("个人访问凭据作用域 / 设备授权状态（WAN-78）", () => {
    expect(tokenScopeEnum.enumValues).toEqual(TokenScope.options);
    expect(deviceAuthStatusEnum.enumValues).toEqual(["PENDING", "APPROVED", "CONSUMED", "DENIED"]);
  });

  it("LLM 配置 / 任务", () => {
    expect(llmScopeEnum.enumValues).toEqual(LlmScope.options);
    expect(llmTaskEnum.enumValues).toEqual(LlmTask.options);
  });
});
