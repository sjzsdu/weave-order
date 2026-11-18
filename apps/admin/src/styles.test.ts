import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 焦点环、跳过导航这类“只在键盘操作时出现”的样式没法在 jsdom 里算出来（没有布局引擎），
 * 这里至少把关键规则钉住，避免它们被后续样式重构悄悄删掉。
 */
const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");

describe("键盘焦点与跳过导航样式", () => {
  it(":focus-visible 用白圈 + 蓝圈，深色侧栏与浅色正文都看得见", () => {
    expect(css).toMatch(/:focus-visible/);
    expect(css).toContain("outline: 2px solid #0b5fff");
    expect(css).toContain("box-shadow: 0 0 0 2px #fff");
  });

  it("skip-link 平时移出视口，聚焦后显示", () => {
    expect(css).toContain(".skip-link");
    expect(css).toContain("transform: translateY(-200%)");
    expect(css).toMatch(/\.skip-link:focus[^{]*\{[^}]*transform: none/);
  });

  it("fieldset/legend 去掉了浏览器默认边框", () => {
    expect(css).toMatch(/fieldset\.field \{[^}]*border: 0/);
  });
});
