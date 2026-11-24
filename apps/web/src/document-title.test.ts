import { describe, expect, it } from "vitest";
import { titleForPath } from "./document-title";

describe("页面标题映射", () => {
  it("登录页有自己的标题", () => {
    expect(titleForPath("/login")).toBe("登录 · 织序 WeaveOrder");
    expect(titleForPath("/login?next=%2F")).toBe("登录 · 织序 WeaveOrder");
  });

  it("工作台与事项各有独立标题", () => {
    expect(titleForPath("/workbench")).toBe("工作台 · 织序 WeaveOrder");
    expect(titleForPath("/items")).toBe("事项 · 织序 WeaveOrder");
    expect(titleForPath("/items/01a2")).toBe("事项 · 织序 WeaveOrder");
  });

  it("资源深链归到资源标题，设置、输入页与小织各自独立", () => {
    expect(titleForPath("/resources")).toBe("资源 · 织序 WeaveOrder");
    expect(titleForPath("/panorama/customers")).toBe("资源 · 织序 WeaveOrder");
    expect(titleForPath("/settings")).toBe("设置 · 织序 WeaveOrder");
    expect(titleForPath("/inbound")).toBe("对小织说句话 · 织序 WeaveOrder");
    expect(titleForPath("/xiaozhi")).toBe("小织 · 织序 WeaveOrder");
    expect(titleForPath("/xiaozhi?text=你好")).toBe("小织 · 织序 WeaveOrder");
  });

  it("未知路径回落到完整产品标题", () => {
    expect(titleForPath("/somewhere-else")).toBe("织序 WeaveOrder · 智能体原生纺织业务系统");
  });
});
