import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 绝对像素约定（postcss-pxtransform 只对大写 `PX` 放过换算）。
 *
 * 根字号与 44px 命中区必须按字面 px 输出；一旦被格式化成小写 `px`，
 * 编译产物会变成 `clamp(.475rem, …)` 自我引用，390 宽下根字号掉到 9.6px。
 * 没有构建断言时这条规则只靠注释守，prettier 一次格式化就会破功。
 *
 * vitest 的 cwd 是 `apps/mobile`（见 package.json 的 test 脚本）。
 */
const scss = readFileSync(join(process.cwd(), "src/app.scss"), "utf8");

describe("app.scss 的绝对像素约定", () => {
  it("根字号用大写 PX，避免被换成 rem", () => {
    expect(scss).toMatch(/font-size:\s*clamp\(19PX,/);
    expect(scss).not.toMatch(/clamp\(19px/);
  });

  it("tabbar 高度与撤销条偏移同样是字面像素", () => {
    expect(scss).toMatch(/--taro-tabbar-height:\s*60PX/);
    expect(scss).toMatch(/height:\s*60PX/);
    expect(scss).toMatch(/\.undo-bar-tab\s*\{[^}]*bottom:\s*calc\(76PX/);
  });

  it("44px 命中区没有被写成小写 px 后 rem 化", () => {
    const hitAreaRules = [...scss.matchAll(/min-height:\s*([^;]+);/g)]
      .map((match) => (match[1] ?? "").trim())
      .filter((value) => value.length > 0);
    expect(hitAreaRules).toContain("44PX");
    expect(hitAreaRules).not.toContain("44px");
  });
});
