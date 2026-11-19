import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 焦点环、跳过导航这类“只在键盘操作时出现”的样式没法在 jsdom 里算出来（没有布局引擎），
 * 这里至少把关键规则钉住，避免它们被后续样式重构悄悄删掉。
 */
const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");

function token(name: string): string {
  const value = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1];
  if (!value) throw new Error(`globals.css 缺少颜色变量 --${name}`);
  return value;
}

/** 从某条选择器的声明块里取 color，用于检查没有走变量的硬编码颜色。 */
function ruleColor(selector: string): string {
  const block = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
  ).exec(css)?.[1];
  const value = block ? /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{6})/.exec(block)?.[1] : undefined;
  if (!value) throw new Error(`globals.css 的 ${selector} 缺少 color`);
  return value;
}

function luminance(hex: string): number {
  const channel = (index: number) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2.1 相对对比度；正文（含小字）要求 ≥ 4.5:1。 */
function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)];
  const light = Math.max(...values);
  const dark = Math.min(...values);
  return (light + 0.05) / (dark + 0.05);
}

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

  it("带帮助文字的多列表单仍按顶部对齐，开通弹窗有独立布局", () => {
    expect(css).toMatch(/\.form\.row \{[^}]*align-items: start/);
    expect(css).toMatch(/dialog\.modal::backdrop/);
    expect(css).toMatch(/\.provision-dialog \.form\.row/);
  });
});

/**
 * 颜色对比度回归（WAN-170 返工）：jsdom 没有布局引擎，axe 的 color-contrast 规则在单测里
 * 永远返回“无违规”，所以这里按 WCAG 公式直接算正文用色的对比度。真实浏览器复核结果见 PR。
 */
describe("正文颜色对比度（WCAG 2.1 AA，≥4.5:1）", () => {
  const cases: { name: string; foreground: string; background: string }[] = [
    {
      name: "次要文字 --muted / 页面底色 --paper",
      foreground: token("muted"),
      background: token("paper"),
    },
    {
      name: "次要文字 --muted / 卡片底色 --surface",
      foreground: token("muted"),
      background: token("surface"),
    },
    {
      name: "次要文字 --muted / 灰底徽标 #eef0f3",
      foreground: token("muted"),
      background: "#eef0f3",
    },
    {
      name: "警告色 --warn / 警告底 --warn-soft",
      foreground: token("warn"),
      background: token("warn-soft"),
    },
    {
      name: "成功色 --ok / 成功底 --ok-soft",
      foreground: token("ok"),
      background: token("ok-soft"),
    },
    {
      name: "危险色 --danger / 危险底 --danger-soft",
      foreground: token("danger"),
      background: token("danger-soft"),
    },
    {
      name: "强调色 --accent / 强调底 --accent-soft",
      foreground: token("accent"),
      background: token("accent-soft"),
    },
    {
      name: "强调色 --accent / 页面底色 --paper",
      foreground: token("accent"),
      background: token("paper"),
    },
    // 侧栏里没有走变量的文字色
    {
      name: "侧栏分组标题 .nav-group .label / 侧栏 --nav",
      foreground: ruleColor(".nav-group .label"),
      background: token("nav"),
    },
    {
      name: "侧栏说明 .brand .sub / 侧栏 --nav",
      foreground: ruleColor(".brand .sub"),
      background: token("nav"),
    },
    {
      name: "侧栏页脚 .sidebar-foot / 侧栏 --nav",
      foreground: ruleColor(".sidebar-foot"),
      background: token("nav"),
    },
    {
      name: "侧栏链接 .nav-link / 侧栏 --nav",
      foreground: ruleColor(".nav-link"),
      background: token("nav"),
    },
  ];

  it.each(cases)("$name", ({ foreground, background }) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});
