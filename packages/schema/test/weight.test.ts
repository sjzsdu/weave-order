import { describe, expect, it } from "vitest";
import { parseWeightGsm, weightGsmLabel } from "../src/weight";

/**
 * 验收口径（WAN-188）：只认「单一数值 + 明确单位」。
 * 这四条是产品拍板的边界，改动前先回到 issue 讨论。
 */
describe("parseWeightGsm", () => {
  it("带单位的单一数值：g/m2、g/㎡、gsm、克重前缀", () => {
    expect(parseWeightGsm("220g/m2")).toBe(220);
    expect(parseWeightGsm("220g/㎡")).toBe(220);
    expect(parseWeightGsm("220gsm")).toBe(220);
    expect(parseWeightGsm("克重220")).toBe(220);
    expect(parseWeightGsm("克重 220 g/m²")).toBe(220);
    expect(parseWeightGsm(" 220 G/M2 ")).toBe(220);
    expect(parseWeightGsm("220 g/m^2")).toBeNull();
  });

  it("区间、纱支、无单位纯数字一律留空", () => {
    expect(parseWeightGsm("220-240")).toBeNull();
    expect(parseWeightGsm("220-240g/m2")).toBeNull();
    expect(parseWeightGsm("32S/2")).toBeNull();
    expect(parseWeightGsm("32支")).toBeNull();
    expect(parseWeightGsm("220")).toBeNull();
  });

  it("多值混写不是单一数值，留空", () => {
    expect(parseWeightGsm("220g/m2 / 240g/m2")).toBeNull();
    expect(parseWeightGsm("220g/m2,240g/m2")).toBeNull();
  });

  it("空值与异常值留空，不抛错", () => {
    expect(parseWeightGsm(null)).toBeNull();
    expect(parseWeightGsm(undefined)).toBeNull();
    expect(parseWeightGsm("   ")).toBeNull();
    expect(parseWeightGsm("0g/m2")).toBeNull();
    expect(parseWeightGsm("99999999gsm")).toBeNull();
  });

  it("小数克重四舍五入到整数", () => {
    expect(parseWeightGsm("220.5g/m2")).toBe(221);
  });

  it("界面文案：解析不到时明确写「未填」", () => {
    expect(weightGsmLabel(220)).toBe("220 g/m²");
    expect(weightGsmLabel(null)).toBe("克重未填");
  });
});
