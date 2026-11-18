// @vitest-environment jsdom
import { act } from "react";
import type { ReactElement, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan, TenantSummary } from "@weave-order/schema";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/tenants",
}));

// 侧栏链接只用来看结构，不需要 Next 的预取（否则测试里会飘 act() 警告）。
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { BreakGlassForm, ConfigForm, PlanForm, ProvisionTenantForm, TicketForm } from "./actions";
import { ConsoleShell } from "./console-shell";
import { Field } from "./form-field";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plans: Plan[] = [
  {
    code: "PRO",
    name: "专业版",
    tier: 2,
    seatMin: 5,
    seatMax: null,
    agentActionsQuota: 20000,
    storageGb: 50,
    features: {},
    status: "ACTIVE",
  },
];

const tenants: TenantSummary[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "qinghe",
    name: "青禾纺织",
    status: "TRIAL",
    isolationMode: "SHARED_RLS",
    region: "cn-east",
    currency: "CNY",
    healthScore: 90,
    planCode: "PRO",
    seats: 10,
    billingCycle: "MONTHLY",
    effectiveMonthlyCents: 99000,
    agentActionsUsed: 0,
    agentActionsQuota: 20000,
    nextDueAt: null,
    createdAt: "2026-11-01T00:00:00.000Z",
  },
];

let mounted: HTMLDivElement[] = [];

/** 用真实 DOM 渲染 client 组件，axe 才能按浏览器语义检查 label 关联。 */
function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  mounted.push(container);
  return container;
}

function controls(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("input:not([type=hidden]), select, textarea")];
}

/** 可见 label 必须用 htmlFor 指向真实控件；控件必须有 label 或 aria-label。 */
function expectLabelsAssociated(container: HTMLElement) {
  for (const label of container.querySelectorAll("label")) {
    if (label.querySelector("input, select, textarea")) continue; // 包裹式隐式关联
    const id = label.getAttribute("for");
    expect(id, `label「${label.textContent?.trim()}」缺少 htmlFor`).toBeTruthy();
    expect(
      container.querySelector(`[id="${id}"]`),
      `label「${label.textContent?.trim()}」的 htmlFor 指向了不存在的控件`,
    ).not.toBeNull();
  }
  for (const control of controls(container)) {
    const id = control.getAttribute("id");
    const hasLabel = id ? container.querySelector(`label[for="${id}"]`) : null;
    const wrapped = control.closest("label");
    const aria = control.getAttribute("aria-label") ?? control.getAttribute("aria-labelledby");
    expect(
      Boolean(hasLabel ?? wrapped ?? aria),
      `控件没有可访问名称：${control.outerHTML.slice(0, 120)}`,
    ).toBe(true);
  }
}

async function axeViolations(container: HTMLElement) {
  const result = await axe.run(container, {
    runOnly: {
      type: "rule",
      values: ["label", "form-field-multiple-labels", "aria-required-attr"],
    },
  });
  return result.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.map((node) => node.target.join(" ")),
  }));
}

beforeEach(() => {
  // jsdom 没有 matchMedia；侧栏抽屉据此判断移动端断点，测试按桌面端处理。
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
  for (const container of mounted) container.remove();
  mounted = [];
});

describe("Field 组件", () => {
  it("把 label 与控件用 htmlFor/id 关联，并把 required 映射为 aria-required", () => {
    const html = renderToStaticMarkup(
      <Field label="公司名称" name="name" required>
        <input required />
      </Field>,
    );
    const id = /<label for="([^"]+)"/.exec(html)?.[1];
    expect(id, "label 缺少 htmlFor").toBeTruthy();
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain('aria-required="true"');
  });

  it("hint 通过 aria-describedby 关联，不覆盖控件自身的描述", () => {
    const html = renderToStaticMarkup(
      <Field label="JSON 值" name="value" hint="必须是合法 JSON">
        <textarea aria-describedby="json-error" />
      </Field>,
    );
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(describedBy.split(" ")).toContain("json-error");
    expect(describedBy.split(" ").some((value) => value.endsWith("-hint"))).toBe(true);
  });

  it("复选框组用 fieldset/legend 命名", () => {
    const container = mount(<PlanForm existingCodes={[]} />);
    const group = container.querySelector("fieldset");
    expect(group?.querySelector("legend")?.textContent).toBe("功能开关");
    expect(group?.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThan(0);
  });
});

describe("控制台外壳", () => {
  const actor = { name: "张三", email: "zhang@example.com", role: "OWNER", permissions: [] };

  it("第一个可聚焦元素是「跳到主内容」，main 是跳转目标且可编程聚焦", () => {
    const container = mount(
      <ConsoleShell actor={actor}>
        <h1>总览</h1>
      </ConsoleShell>,
    );
    const first = container.querySelector<HTMLElement>(
      "a, button, input, select, textarea, [tabindex]",
    );
    expect(first?.textContent).toBe("跳到主内容");
    expect(first?.getAttribute("href")).toBe("#main");
    const main = container.querySelector("main");
    expect(main?.id).toBe("main");
    expect(main?.getAttribute("tabindex")).toBe("-1");
  });
});

describe("表单可访问性（axe）", () => {
  const cases: [string, ReactElement][] = [
    ["/tenants 开通公司", <ProvisionTenantForm plans={plans} />],
    ["/support 工单", <TicketForm tenants={tenants} />],
    ["/support Break-glass", <BreakGlassForm tenants={tenants} />],
    ["/settings/config 发布新版本", <ConfigForm />],
  ];

  it.each(cases)("%s：label 与控件一一关联", (_name, element) => {
    expectLabelsAssociated(mount(element));
  });

  it.each(cases)("%s：axe 无 label 相关违规", async (_name, element) => {
    expect(await axeViolations(mount(element))).toEqual([]);
  });

  it("必填字段同时带 required 与 aria-required", () => {
    const container = mount(<ConfigForm />);
    const key = container.querySelector("input[required]");
    expect(key?.getAttribute("aria-required")).toBe("true");
    expect(key?.id).toBeTruthy();
  });
});
