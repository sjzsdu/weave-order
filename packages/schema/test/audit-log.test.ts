import { describe, expect, it } from "vitest";
import {
  AUDIT_HIGH_RISK_ACTIONS,
  AUDIT_MASKED_PRICE,
  diffAuditSnapshots,
  formatAuditValue,
  isHighRiskAuditAction,
  maskAuditSnapshot,
} from "../src/audit-log";

describe("字段级差异", () => {
  it("只输出真正变化的字段，新增/删除字段也能表达", () => {
    const diffs = diffAuditSnapshots(
      { tier: "VIP", name: "青禾", removed: 1 },
      { tier: "REGULAR", name: "青禾", added: true },
    );
    expect(diffs.map((diff) => diff.field).sort()).toEqual(["added", "removed", "tier"]);
    expect(diffs.find((diff) => diff.field === "tier")).toMatchObject({
      before: "VIP",
      after: "REGULAR",
    });
    expect(diffs.find((diff) => diff.field === "removed")?.after).toBeNull();
  });

  it("before/after 都为 null 时没有差异", () => {
    expect(diffAuditSnapshots(null, null)).toEqual([]);
  });

  it("对象按值比较，不把相同内容拆成伪差异", () => {
    expect(diffAuditSnapshots({ qty: { value: 1 } }, { qty: { value: 1 } })).toEqual([]);
    expect(diffAuditSnapshots({ qty: { value: 1 } }, { qty: { value: 2 } })).toHaveLength(1);
  });
});

describe("敏感金额裁剪", () => {
  it("无 sample.cost.view 时成本价被替换为占位文案", () => {
    const { value, maskedFields } = maskAuditSnapshot(
      { costFloorAmount: 1200, name: "棉布" },
      { allowCost: false, allowPricing: true, entityType: "sample" },
    );
    expect(value).toEqual({ costFloorAmount: AUDIT_MASKED_PRICE, name: "棉布" });
    expect(maskedFields).toEqual(["costFloorAmount"]);
  });

  it("有成本能力时保留原值", () => {
    const { value, maskedFields } = maskAuditSnapshot(
      { costFloorAmount: 1200 },
      { allowCost: true, allowPricing: false, entityType: "sample" },
    );
    expect(value).toEqual({ costFloorAmount: 1200 });
    expect(maskedFields).toEqual([]);
  });

  it("报价策略的 value 只对无定价能力的人裁剪", () => {
    const masked = maskAuditSnapshot(
      { key: "price.floor", value: 990 },
      { allowCost: false, allowPricing: false, entityType: "pricing_policy" },
    );
    expect(masked.value).toEqual({ key: "price.floor", value: AUDIT_MASKED_PRICE });

    const visible = maskAuditSnapshot(
      { key: "price.floor", value: 990 },
      { allowCost: false, allowPricing: true, entityType: "pricing_policy" },
    );
    expect(visible.value).toEqual({ key: "price.floor", value: 990 });
  });

  it("嵌套对象里的成本字段也会被裁剪，并给出完整路径", () => {
    const { value, maskedFields } = maskAuditSnapshot(
      { item: { unitCost: 88, qty: 2 } },
      { allowCost: false, allowPricing: false, entityType: "quote" },
    );
    expect(value).toEqual({ item: { unitCost: AUDIT_MASKED_PRICE, qty: 2 } });
    expect(maskedFields).toEqual(["item.unitCost"]);
  });
});

describe("高风险动作口径", () => {
  it("批准、驳回、改价、删除、权限、选项变更都在名单里", () => {
    for (const action of [
      "QUOTE_CONFIRMED",
      "QUOTE_REJECTED",
      "SAMPLE_SHIPMENT_REJECTED",
      "QUOTE_DRAFT_REVISED",
      "SAMPLE_ARCHIVED",
      "MEMBERSHIP_ROLE_CHANGED",
      "FIELD_OPTION_MERGED",
    ]) {
      expect(isHighRiskAuditAction(action), action).toBe(true);
    }
  });

  it("普通读取类动作不被标记", () => {
    expect(isHighRiskAuditAction("CUSTOMER_CREATED")).toBe(false);
    expect(isHighRiskAuditAction("QUOTE_SHARE_CREATED")).toBe(false);
    expect(AUDIT_HIGH_RISK_ACTIONS.length).toBeGreaterThan(10);
  });
});

describe("字段值展示", () => {
  it("null / 布尔 / 对象都有稳定的中文表现", () => {
    expect(formatAuditValue(null)).toBe("—");
    expect(formatAuditValue(true)).toBe("是");
    expect(formatAuditValue(false)).toBe("否");
    expect(formatAuditValue("")).toBe("—");
    expect(formatAuditValue({ a: 1 })).toBe('{"a":1}');
  });
});
