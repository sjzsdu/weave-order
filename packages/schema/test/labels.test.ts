import { describe, expect, it } from "vitest";
import { AuditAction } from "../src/kernel";
import {
  ACTOR_TYPE_LABEL,
  AUDIT_ACTION_LABEL,
  actorTypeLabel,
  auditActionLabel,
  UNKNOWN_AUDIT_ACTION_LABEL,
} from "../src/labels";

describe("审计文案", () => {
  it("每个 AuditAction 都有中文文案，不会把枚举丢给用户", () => {
    const missing = AuditAction.options.filter((action) => !AUDIT_ACTION_LABEL[action]);
    expect(missing).toEqual([]);
  });

  it("未知动作走通用话术", () => {
    expect(auditActionLabel("SOMETHING_NEW")).toBe(UNKNOWN_AUDIT_ACTION_LABEL);
    expect(auditActionLabel("SOMETHING_NEW")).not.toMatch(/^[A-Z_]+$/);
  });

  it("identity 与动作类型都说人话", () => {
    expect(auditActionLabel("MEMBERSHIP_REVOKED")).toBe("撤销了成员邀请");
    expect(actorTypeLabel("AGENT")).toBe("智能体");
    expect(actorTypeLabel("HUMAN")).toBe("人工");
    expect(actorTypeLabel(null)).toBe("系统");
    expect(Object.keys(ACTOR_TYPE_LABEL)).toEqual(["AGENT", "HUMAN", "SYSTEM"]);
  });
});
