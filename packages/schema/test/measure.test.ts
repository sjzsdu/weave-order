import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEASURE_UNITS,
  parseWeightMeasurement,
  parseWidthMeasurement,
  toCm,
  toGsm,
  weightGsmOf,
  weightLabel,
  weightMeasurementFrom,
  weightSearchText,
  widthCmOf,
  widthLabel,
  widthMeasurementFrom,
  widthSearchText,
} from "../src/measure";

/**
 * 单位受控之后的判定口径。
 *
 * 「区间、纱支、无单位纯数字一律留空」这三条是产品拍板的边界
 * （仓库里原本就有 `parseWeightGsm` 的同名约定），改动前先回到 issue 讨论。
 */
describe("parseWeightMeasurement", () => {
  it("带单位的单一数值：g/m²、g/㎡、gsm、克重前缀", () => {
    expect(parseWeightMeasurement("220g/m2")).toEqual({ value: 220, unit: "gsm" });
    expect(parseWeightMeasurement("220g/㎡")).toEqual({ value: 220, unit: "gsm" });
    expect(parseWeightMeasurement("220gsm")).toEqual({ value: 220, unit: "gsm" });
    expect(parseWeightMeasurement("克重220")).toEqual({ value: 220, unit: "gsm" });
    expect(parseWeightMeasurement("克重 220 g/m²")).toEqual({ value: 220, unit: "gsm" });
    expect(parseWeightMeasurement(" 220 G/M2 ")).toEqual({ value: 220, unit: "gsm" });
    expect(parseWeightMeasurement("220 g/m^2")).toBeNull();
  });

  it("oz/yd² 与 kg/m² 认自己的单位，不折成 g/m²", () => {
    expect(parseWeightMeasurement("6.5oz/yd2")).toEqual({ value: 6.5, unit: "oz" });
    expect(parseWeightMeasurement("6.5oz")).toEqual({ value: 6.5, unit: "oz" });
    expect(parseWeightMeasurement("0.22kg/m2")).toEqual({ value: 0.22, unit: "kgm2" });
    expect(parseWeightMeasurement("克重 6.5 oz/yd²")).toEqual({ value: 6.5, unit: "oz" });
  });

  it("区间、纱支、无单位纯数字一律留空", () => {
    expect(parseWeightMeasurement("220-240")).toBeNull();
    expect(parseWeightMeasurement("220-240g/m2")).toBeNull();
    expect(parseWeightMeasurement("32S/2")).toBeNull();
    expect(parseWeightMeasurement("32支")).toBeNull();
    expect(parseWeightMeasurement("220")).toBeNull();
  });

  it("多值混写不是单一数值，留空", () => {
    expect(parseWeightMeasurement("220g/m2 / 240g/m2")).toBeNull();
    expect(parseWeightMeasurement("220g/m2,240g/m2")).toBeNull();
  });

  it("空值与异常值留空，不抛错", () => {
    expect(parseWeightMeasurement(null)).toBeNull();
    expect(parseWeightMeasurement(undefined)).toBeNull();
    expect(parseWeightMeasurement("   ")).toBeNull();
    expect(parseWeightMeasurement("0g/m2")).toBeNull();
    expect(parseWeightMeasurement("99999999gsm")).toBeNull();
  });
});

describe("parseWidthMeasurement", () => {
  it("厘米 / 英寸 / 米各认各的", () => {
    expect(parseWidthMeasurement("150cm")).toEqual({ value: 150, unit: "cm" });
    expect(parseWidthMeasurement("150 cm")).toEqual({ value: 150, unit: "cm" });
    expect(parseWidthMeasurement("59in")).toEqual({ value: 59, unit: "in" });
    expect(parseWidthMeasurement("59inch")).toEqual({ value: 59, unit: "in" });
    expect(parseWidthMeasurement("1.5m")).toEqual({ value: 1.5, unit: "m" });
    expect(parseWidthMeasurement("门幅150")).toEqual({ value: 150, unit: "cm" });
  });

  it("区间、无单位纯数字留空", () => {
    expect(parseWidthMeasurement("150-160")).toBeNull();
    expect(parseWidthMeasurement("150")).toBeNull();
    expect(parseWidthMeasurement("")).toBeNull();
  });
});

describe("换算", () => {
  it("克重折到 g/m²：oz/yd² 与 kg/m² 走各自系数", () => {
    expect(toGsm(220, "gsm")).toBe(220);
    expect(toGsm(1, "oz")).toBeCloseTo(33.9059, 4);
    expect(toGsm(1, "kgm2")).toBe(1000);
    expect(weightGsmOf({ value: 6.5, unit: "oz" })).toBe(220);
  });

  it("门幅折到 cm：英寸用定义值 2.54", () => {
    expect(toCm(150, "cm")).toBe(150);
    expect(toCm(1, "in")).toBeCloseTo(2.54, 6);
    expect(toCm(1, "m")).toBe(100);
    expect(widthCmOf({ value: 59, unit: "in" })).toBe(150);
  });
});

describe("展示与检索文本", () => {
  it("检索文本是规范写法，与检索词能对上", () => {
    expect(weightSearchText({ value: 220, unit: "gsm" })).toBe("220g/m2");
    expect(weightSearchText({ value: 6.5, unit: "oz" })).toBe("6.5oz/yd2");
    expect(weightSearchText({ value: 0.22, unit: "kgm2" })).toBe("0.22kg/m2");
    expect(widthSearchText({ value: 150, unit: "cm" })).toBe("150cm");
  });

  it("展示文案带单位；空值给 null（界面自己写「未填」）", () => {
    expect(weightLabel({ value: 220, unit: "gsm" })).toBe("220 g/m²");
    expect(weightLabel({ value: 6.5, unit: "oz" })).toBe("6.5 oz/yd²");
    expect(weightLabel(null)).toBeNull();
    expect(widthLabel({ value: 150, unit: "cm" })).toBe("150 cm");
    expect(widthLabel(null)).toBeNull();
  });
});

describe("从库里的一对列还原", () => {
  it("单位非法或缺值一律读成 null", () => {
    expect(weightMeasurementFrom(220, "gsm")).toEqual({ value: 220, unit: "gsm" });
    expect(weightMeasurementFrom(220, "xx")).toBeNull();
    expect(weightMeasurementFrom(null, "gsm")).toBeNull();
    expect(widthMeasurementFrom(150, "cm")).toEqual({ value: 150, unit: "cm" });
    expect(widthMeasurementFrom(150, null)).toBeNull();
  });
});

describe("租户默认单位", () => {
  it("默认是 g/m² 与 cm", () => {
    expect(DEFAULT_MEASURE_UNITS).toEqual({ weight: "gsm", width: "cm" });
  });
});
