import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 回归守卫：WAN-169 之前所有页面共用根布局的一个标题，浏览器标签与历史无法区分。
 * 这里从源码层面锁住「每个 page.tsx 都有自己的标题」以及「404 是自有中文页」，
 * 避免新增路由时又忘写 metadata。
 */
const APP_DIR = fileURLToPath(new URL("../app", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** app/(console)/tenants/[id]/page.tsx → /tenants/[id] */
function routeOf(pageFile: string): string {
  const dir = relative(APP_DIR, join(pageFile, ".."));
  const segments = dir.split(sep).filter((segment) => !segment.startsWith("("));
  return `/${segments.join("/")}`;
}

const pages = walk(APP_DIR).filter((file) => file.endsWith(`${sep}page.tsx`));

describe("控制台页面标题", () => {
  it("每个 page.tsx 都声明了 metadata 或 generateMetadata", () => {
    const missing = pages.filter((file) => {
      const source = readFileSync(file, "utf8");
      return !/export const metadata|export async function generateMetadata/.test(source);
    });
    expect(missing.map((file) => relative(APP_DIR, file))).toEqual([]);
  });

  it("静态标题互不重复，且只写页面名（品牌由根布局模板拼接）", () => {
    const titles = pages
      .map((file) => ({ route: routeOf(file), source: readFileSync(file, "utf8") }))
      .filter(({ source }) => !source.includes("generateMetadata"))
      .map(({ route, source }) => {
        const match = source.match(/export const metadata[^;]*?title:\s*"([^"]+)"/s);
        return { route, title: match?.[1] ?? null };
      });

    expect(titles.filter((item) => !item.title)).toEqual([]);
    const names = titles.map((item) => item.title as string);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name.includes("万鸟科技"))).toEqual([]);
  });

  it("关键路由的标题包含页面名", () => {
    const titleOf = (route: string) => {
      const page = pages.find((file) => routeOf(file) === route);
      expect(page, `缺少路由 ${route}`).toBeTruthy();
      return readFileSync(page as string, "utf8").match(/title:\s*"([^"]+)"/)?.[1];
    };

    expect(titleOf("/")).toBe("总览");
    expect(titleOf("/tenants")).toBe("租户");
    expect(titleOf("/billing")).toBe("订阅账单");
    expect(titleOf("/audit")).toBe("平台审计");
    expect(titleOf("/settings/llm")).toContain("LLM 设置");
  });

  it("根布局用模板追加品牌，而不是让每页各写一遍", () => {
    const layout = readFileSync(join(APP_DIR, "layout.tsx"), "utf8");
    expect(layout).toContain('template: "%s · 万鸟科技"');
    expect(layout).toContain('default: "万鸟科技 · 平台总管理端"');
  });
});

describe("404 页面", () => {
  const source = readFileSync(join(APP_DIR, "not-found.tsx"), "utf8");

  it("使用中文文案与品牌，不再是 Next.js 默认英文页", () => {
    expect(source).not.toContain("This page could not be found");
    expect(source).toContain("没有找到这个页面");
    expect(source).toContain("万鸟科技");
  });

  it("提供返回入口", () => {
    expect(source).toContain("返回总览");
    expect(source).toContain("去租户");
    expect(source).toContain("前往登录页");
  });

  it("不暴露内部错误信息", () => {
    expect(source).not.toMatch(/digest|stack|Error:/);
  });
});
