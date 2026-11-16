import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION_LABEL,
  BUSINESS_AUDIT_ACTIONS,
  agentLabelForAction,
  auditActionLabel,
  isBusinessAuditAction,
} from "../src/kernel";

/**
 * 工作台动态流的分类契约：系统初始化事件不是「智能体的成果」，
 * 任何动作都必须有中文文案，界面不允许直出枚举。
 */
describe("业务事件分类与文案", () => {
  it("系统 / 身份 / 打印作业类事件不进动态流", () => {
    for (const action of [
      "TENANT_CREATED",
      "MEMBERSHIP_CREATED",
      "MEMBERSHIP_INVITED",
      "TENANT_SWITCHED",
      "LLM_SETTINGS_UPDATED",
      "USER_CREATED",
      "API_TOKEN_CREATED",
      "PRINT_JOB_CREATED",
      "SAMPLE_INDEX_FAILED",
    ] as const) {
      expect(isBusinessAuditAction(action)).toBe(false);
    }
  });

  it("业务动作进动态流", () => {
    for (const action of ["QUOTE_DRAFT_GENERATED", "CUSTOMER_CREATED", "SAMPLE_CREATED"] as const) {
      expect(isBusinessAuditAction(action)).toBe(true);
    }
    expect(BUSINESS_AUDIT_ACTIONS.length).toBeGreaterThan(20);
  });

  it("每个业务动作都有中文文案，未知动作给通用话术而不是枚举", () => {
    for (const action of BUSINESS_AUDIT_ACTIONS) {
      expect(AUDIT_ACTION_LABEL[action]).toBeTruthy();
    }
    expect(auditActionLabel("SOMETHING_NEW")).toBe("更新了业务数据");
  });

  it("智能体归属按动作前缀判断", () => {
    expect(agentLabelForAction("QUOTE_CONFIRMED")).toBe("小织");
    expect(agentLabelForAction("SAMPLE_SHIPMENT_DRAFTED")).toBe("小跟");
    expect(agentLabelForAction("CUSTOMER_CREATED")).toBe("小序");
  });
});
