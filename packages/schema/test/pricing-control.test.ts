import { describe, expect, it } from "vitest";
import {
  CONTROL_DIRECTION,
  CONTROL_PRICING_KEYS,
  PricingKey,
  controlDirection,
  isControlPricingKey,
} from "../src";

/**
 * 管控键口径收敛：每个 PricingKey 必须显式声明「是否管控 + 方向」。
 *
 * `CONTROL_DIRECTION` 用 `satisfies Record<PricingKey, ...>` 在编译期就强制
 * 键集合封闭（新增键忘了补声明会直接编译失败）；这里的运行期用例是第二道闸，
 * 防止有人绕过类型用 `as` 造假，也把「全覆盖」这个契约固定成可读的断言。
 */
describe("PricingKey 管控口径全覆盖", () => {
  it("每个键都在 CONTROL_DIRECTION 里显式声明了方向", () => {
    for (const key of PricingKey.options) {
      expect(
        key in CONTROL_DIRECTION,
        `${key} 未在 CONTROL_DIRECTION 声明管控口径（新增键忘了补声明）`,
      ).toBe(true);
    }
  });

  it("CONTROL_DIRECTION 不包含任何 PricingKey 之外的野生键", () => {
    for (const key of Object.keys(CONTROL_DIRECTION)) {
      expect(PricingKey.options, `CONTROL_DIRECTION 含未注册键 ${key}`).toContain(key);
    }
  });

  it("每个键的方向都是合法的 ControlDirection 或 null", () => {
    for (const key of PricingKey.options) {
      const direction = CONTROL_DIRECTION[key];
      expect(
        direction === null || direction === "MIN" || direction === "MAX",
        `${key} 的方向 ${String(direction)} 非法`,
      ).toBe(true);
    }
  });

  it("CONTROL_PRICING_KEYS 与 CONTROL_DIRECTION 一致（方向非 null 的键）", () => {
    const expected = PricingKey.options.filter((key) => CONTROL_DIRECTION[key] !== null);
    expect([...CONTROL_PRICING_KEYS].sort()).toEqual([...expected].sort());
  });

  it("controlDirection / isControlPricingKey 与声明一致", () => {
    for (const key of PricingKey.options) {
      const declared = CONTROL_DIRECTION[key];
      expect(controlDirection(key)).toBe(declared);
      expect(isControlPricingKey(key)).toBe(declared !== null);
    }
  });

  it("改幅升级阈值属于管控键（MAX：只能压低，不能放宽）", () => {
    expect(controlDirection("pricing.reprice_escalation_pct")).toBe("MAX");
    expect(controlDirection("pricing.reprice_escalation_amount")).toBe("MAX");
    expect(isControlPricingKey("pricing.reprice_escalation_pct")).toBe(true);
    expect(isControlPricingKey("pricing.reprice_escalation_amount")).toBe(true);
  });

  it("建议类键（默认毛利）非管控", () => {
    expect(controlDirection("pricing.default_margin_pct")).toBeNull();
    expect(isControlPricingKey("pricing.default_margin_pct")).toBe(false);
  });
});
