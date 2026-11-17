import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Time } from "./time";

describe("Time 组件", () => {
  it("按北京时间渲染，并在 tooltip 中保留原始 UTC 时间", () => {
    const html = renderToStaticMarkup(<Time value="2026-11-17T05:03:30.956Z" />);
    expect(html).toMatch(/^<time [^>]*>2026\/11\/17 13:03<\/time>$/);
    expect(html).toContain('title="2026-11-17T05:03:30.956Z · 北京时间（UTC+8） · Asia/Shanghai"');
  });

  it("day 模式按北京时间跨天", () => {
    const html = renderToStaticMarkup(<Time value="2026-11-17T16:30:00.000Z" mode="day" />);
    expect(html).toContain(">2026/11/18</time>");
  });

  it("到期日按北京时间取日，不因 UTC 日期提前一天", () => {
    // 北京时间 2026-12-16 02:30，曾因截 ISO 字符串显示成 2026-12-15
    const html = renderToStaticMarkup(<Time value="2026-12-15T18:30:00.000Z" mode="day" />);
    expect(html).toContain(">2026/12/16</time>");
  });

  it("空值与非法值渲染占位符", () => {
    expect(renderToStaticMarkup(<Time value={null} />)).toBe("—");
    expect(renderToStaticMarkup(<Time value="not-a-date" />)).toBe("—");
  });
});
