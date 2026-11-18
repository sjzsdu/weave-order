import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SampleSavedToast, sampleSavedTitle, toSampleSaveFeedback } from "./sample-saved-toast";

const edited = toSampleSaveFeedback({ id: "s1", name: "改后的品名", code: "NEW-CODE" }, false);
const created = toSampleSaveFeedback({ id: "s2", name: "新品名", code: "SP-0001" }, true);

/**
 * WAN-149 返工：编辑保存曾弹「样品「<旧品名>」已建」。
 * 这里锁住两件事：文案按操作分叉；名称/编号取自回传实体（编辑时必须是最新值）。
 */
describe("SampleSavedToast", () => {
  it("编辑保存显示「已更新」，不回落到「已建」", () => {
    const html = renderToStaticMarkup(
      <SampleSavedToast feedback={edited} onDismiss={() => {}} onOpen={() => {}} />,
    );
    expect(html).toContain("已更新");
    expect(html).not.toContain("已建");
  });

  it("编辑保存的名称与编号取自保存后的实体", () => {
    expect(edited).toMatchObject({ name: "改后的品名", code: "NEW-CODE", created: false });
    const html = renderToStaticMarkup(
      <SampleSavedToast feedback={edited} onDismiss={() => {}} onOpen={() => {}} />,
    );
    expect(html).toContain("改后的品名");
    expect(html).toContain("NEW-CODE");
  });

  it("新建保存仍显示「已建」", () => {
    const html = renderToStaticMarkup(
      <SampleSavedToast feedback={created} onDismiss={() => {}} onOpen={() => {}} />,
    );
    expect(html).toContain("已建");
    expect(html).not.toContain("已更新");
  });

  it("标题按 created 分叉", () => {
    expect(sampleSavedTitle({ name: "A", created: true })).toBe("样品「A」已建");
    expect(sampleSavedTitle({ name: "A", created: false })).toBe("样品「A」已更新");
  });
});
