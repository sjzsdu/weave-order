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

describe("成员角色与审计实体文案", () => {
  it("角色一律中文，未知值不裸输出", async () => {
    const { memberRoleLabel, MEMBER_ROLE_LABEL } = await import("../src/labels");
    expect(memberRoleLabel("SALES")).toBe("销售");
    expect(memberRoleLabel("OWNER")).toBe("负责人");
    expect(memberRoleLabel("SOMETHING_ELSE")).toBe("成员");
    expect(Object.keys(MEMBER_ROLE_LABEL)).toHaveLength(7);
  });

  it("审计实体名不暴露数据库表名", async () => {
    const { auditEntityLabel } = await import("../src/labels");
    expect(auditEntityLabel("sample_shipment")).toBe("寄样单");
    expect(auditEntityLabel("membership")).toBe("成员");
    expect(auditEntityLabel("internal_thing")).toBe("业务记录");
    expect(auditEntityLabel(null)).toBe("业务记录");
  });
});
