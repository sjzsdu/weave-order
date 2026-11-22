import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompositionInput } from "../src/composition-input";

/**
 * 成分输入组件的静态渲染。
 *
 * 只锁「看得见的那部分」：文本模式显示原文，配比模式显示派生文本，
 * 以及配比模式的提示行。交互（展开面板、点应用）由契约层与接口测试兜底。
 */
const materials = [
  { code: "MAT-COTTON", label: "棉" },
  { code: "MAT-LINEN", label: "亚麻" },
];

describe("CompositionInput", () => {
  it("文本模式：输入框里是原文，旁边有「按原料配比」入口", () => {
    const html = renderToStaticMarkup(
      <CompositionInput
        value="供应商给的口头成分"
        parts={null}
        materials={materials}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("供应商给的口头成分");
    expect(html).toContain("按原料配比");
    expect(html).not.toContain("当前是配比录入");
  });

  it("配比模式：输入框显示派生文本，并说明文本由配比生成", () => {
    const html = renderToStaticMarkup(
      <CompositionInput
        value=""
        parts={[
          { code: "MAT-COTTON", percent: 55 },
          { code: "MAT-LINEN", percent: 45 },
        ]}
        materials={materials}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("55% 棉 45% 亚麻");
    expect(html).toContain("当前是配比录入");
  });

  it("没有原料清单时不空转：仍可文本录入", () => {
    const html = renderToStaticMarkup(
      <CompositionInput value="" parts={null} materials={[]} onChange={() => {}} />,
    );
    expect(html).toContain("按原料配比");
  });
});
