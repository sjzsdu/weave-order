import { describe, expect, it } from "vitest";
import {
  CompositionParts,
  CompositionPartsInput,
  compositionPercentText,
  compositionText,
  mergeCompositionParts,
} from "../src/composition";

/**
 * 成分配比的纯规则：
 * - 合计必须正好 100%（硬门槛）；
 * - 同一原料不能出现两次；
 * - 文本由配比派生，排序按比例降序；
 * - 合并原料时比例守恒。
 */
const COTTON = { code: "MAT-COTTON", label: "棉", percent: 55 };
const LINEN = { code: "MAT-LINEN", label: "麻", percent: 45 };

describe("CompositionPartsInput", () => {
  it("合计正好 100% 才通过", () => {
    expect(CompositionPartsInput.safeParse([COTTON, LINEN]).success).toBe(true);
    const short = CompositionPartsInput.safeParse([
      { code: "MAT-COTTON", percent: 55 },
      { code: "MAT-LINEN", percent: 40 },
    ]);
    expect(short.success).toBe(false);
    if (!short.success) expect(short.error.issues[0]?.message).toContain("100%");
  });

  it("小数比例允许（52.5 / 47.5）", () => {
    expect(
      CompositionPartsInput.safeParse([
        { code: "MAT-COTTON", percent: 52.5 },
        { code: "MAT-LINEN", percent: 47.5 },
      ]).success,
    ).toBe(true);
  });

  it("同一原料出现两次要被拒：得先合并百分比", () => {
    const parsed = CompositionPartsInput.safeParse([
      { code: "MAT-COTTON", percent: 30 },
      { code: "MAT-COTTON", percent: 70 },
    ]);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain("两次");
  });

  it("空配比与超量项数都被拒", () => {
    expect(CompositionPartsInput.safeParse([]).success).toBe(false);
    const many = Array.from({ length: 11 }, (_, index) => ({
      code: `MAT-${index}`,
      percent: 100 / 11,
    }));
    expect(CompositionPartsInput.safeParse(many).success).toBe(false);
  });
});

describe("compositionText", () => {
  it("按比例降序写出成分串", () => {
    expect(compositionText([LINEN, COTTON])).toBe("55% 棉 45% 麻");
  });

  it("小数不带多余零", () => {
    expect(compositionPercentText(52.5)).toBe("52.5");
    expect(compositionPercentText(55)).toBe("55");
    expect(compositionText([
      { code: "MAT-COTTON", label: "棉", percent: 52.5 },
      { code: "MAT-LINEN", label: "麻", percent: 47.5 },
    ])).toBe("52.5% 棉 47.5% 麻");
  });

  it("同一份配比每次渲染一致", () => {
    const parts = CompositionParts.parse([
      { code: "MAT-COTTON", label: "棉", percent: 50 },
      { code: "MAT-LINEN", label: "麻", percent: 50 },
    ]);
    expect(compositionText(parts)).toBe(compositionText([...parts].reverse()));
  });
});

describe("mergeCompositionParts", () => {
  it("把源原料并进目标原料，比例守恒", () => {
    const merged = mergeCompositionParts(
      [
        { code: "MAT-COTTON", label: "棉", percent: 55 },
        { code: "MAT-LINEN", label: "麻", percent: 45 },
      ],
      "MAT-COTTON",
      { code: "MAT-COTTON-NEW", label: "棉(新)" },
    );
    expect(merged).toEqual([
      { code: "MAT-COTTON-NEW", label: "棉(新)", percent: 55 },
      { code: "MAT-LINEN", label: "麻", percent: 45 },
    ]);
    expect(merged.reduce((acc, part) => acc + part.percent, 0)).toBe(100);
  });

  it("目标原料本来就在配比里：两项合并成一项，合计仍是 100", () => {
    const merged = mergeCompositionParts(
      [
        { code: "MAT-COTTON", label: "棉", percent: 30 },
        { code: "MAT-LINEN", label: "麻", percent: 70 },
      ],
      "MAT-LINEN",
      { code: "MAT-COTTON", label: "棉" },
    );
    expect(merged).toEqual([{ code: "MAT-COTTON", label: "棉", percent: 100 }]);
  });
});
