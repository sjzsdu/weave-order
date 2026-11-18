import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// ConsoleShell 是客户端组件，但这组断言只关心首屏静态结构（抽屉入口、导航语义）。
vi.mock("next/navigation", () => ({ usePathname: () => "/tenants" }));

import { ConsoleShell } from "./console-shell";

const actor = {
  name: "演示 Owner",
  email: "owner@weaveorder.cn",
  role: "platform_owner",
  permissions: ["overview:read"],
};

describe("ConsoleShell 移动端导航", () => {
  const html = renderToStaticMarkup(
    <ConsoleShell actor={actor}>
      <p>正文</p>
    </ConsoleShell>,
  );

  it("提供默认收起的抽屉入口，并把它和侧栏关联", () => {
    expect(html).toContain('class="mobile-bar"');
    expect(html).toContain('aria-controls="console-nav"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('id="console-nav"');
    expect(html).toContain('class="sidebar-backdrop"');
  });

  it("侧栏保留完整导航，并标出当前页", () => {
    expect(html.match(/class="nav-link/g)).toHaveLength(13);
    expect(html).toContain('class="nav-link active"');
    expect(html).toContain('aria-current="page"');
  });

  it("正文仍在 main 里，抽屉不遮挡初始渲染", () => {
    expect(html).toContain('<main id="main" class="main" tabindex="-1"><p>正文</p></main>');
  });
});
