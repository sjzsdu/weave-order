import { describe, expect, it } from "vitest";
import { resolveBackAction } from "../src/lib/back-nav";

/**
 * PWA（display: standalone）没有浏览器返回按钮，二级页的返回控件必须在
 * 「页面栈只有一层」时也能给出出口，否则用户只能杀掉应用重开。
 */

describe("二级页返回动作", () => {
  it("有上一页时正常 navigateBack", () => {
    expect(resolveBackAction(2, "/pages/today/index")).toEqual({ kind: "back" });
    expect(resolveBackAction(5, "/pages/today/index")).toEqual({ kind: "back" });
  });

  it("直接打开二级页 / PWA 冷启动时回退到今日 tab", () => {
    expect(resolveBackAction(1, "/pages/today/index")).toEqual({
      kind: "tab",
      url: "/pages/today/index",
    });
  });

  it("空栈（异常启动）同样回到今日 tab，不产生无出口页面", () => {
    expect(resolveBackAction(0, "/pages/today/index")).toEqual({
      kind: "tab",
      url: "/pages/today/index",
    });
  });

  it("回退目标可指定为其他 tab", () => {
    expect(resolveBackAction(1, "/pages/more/index")).toEqual({
      kind: "tab",
      url: "/pages/more/index",
    });
  });
});
