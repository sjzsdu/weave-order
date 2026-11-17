import { describe, expect, it, vi } from "vitest";
import { createStartupNav } from "../src/lib/startup-nav";

/**
 * 启动时序回归：Taro H5「没有找到页面实例」由「setAuthReady 后未等首屏挂载就 reLaunch」触发。
 * 这里以纯控制器复现信号顺序，固定两个不变式：挂载后才导航、导航只执行一次。
 */

describe("移动端启动导航时序", () => {
  it("新注册用户：首屏挂载后进入创建公司页，且只导航一次", () => {
    const navigateToStart = vi.fn();
    const nav = createStartupNav({ navigateToStart });

    // 认证判定先完成，请求导航；此时首屏尚未挂载，不能导航。
    nav.requestStart();
    expect(navigateToStart).not.toHaveBeenCalled();
    expect(nav.startRequested).toBe(true);

    // 首屏挂载后触发导航。
    nav.markPageMounted();
    expect(navigateToStart).toHaveBeenCalledOnce();
    expect(nav.navigated).toBe(true);
  });

  it("先挂载后请求（OIDC 回调后冷启动）同样能导航一次，且不早于挂载", () => {
    const navigateToStart = vi.fn();
    const nav = createStartupNav({ navigateToStart });

    nav.markPageMounted();
    expect(navigateToStart).not.toHaveBeenCalled(); // 还没判定需要创建公司

    nav.requestStart();
    expect(navigateToStart).toHaveBeenCalledOnce();
  });

  it("已有公司用户：不请求导航，永不跳转", () => {
    const navigateToStart = vi.fn();
    const nav = createStartupNav({ navigateToStart });

    nav.markPageMounted();
    nav.clearStart(); // 已有公司分支：明确撤销请求
    expect(navigateToStart).not.toHaveBeenCalled();
    expect(nav.navigated).toBe(false);
  });

  it("api.me() 失败：不跳转，且保留可恢复状态供重试", () => {
    const navigateToStart = vi.fn();
    const nav = createStartupNav({ navigateToStart });

    // 失败路径：markPageMounted 已发生，但 clearStart 撤销请求。
    nav.markPageMounted();
    nav.clearStart();
    expect(navigateToStart).not.toHaveBeenCalled();
    expect(nav.startRequested).toBe(false);
    expect(nav.navigated).toBe(false); // 未导航 → 重试仍可进行

    // 重试成功后再请求，仍可导航一次。
    nav.requestStart();
    expect(navigateToStart).toHaveBeenCalledOnce();
  });

  it("重复渲染 / effect 重入：不重复导航（至多一次）", () => {
    const navigateToStart = vi.fn();
    const nav = createStartupNav({ navigateToStart });

    // 模拟 React StrictMode / 多次渲染：两个信号被反复送入。
    for (let i = 0; i < 5; i += 1) {
      nav.markPageMounted();
      nav.requestStart();
    }
    expect(navigateToStart).toHaveBeenCalledOnce();
  });

  it("反复 clearStart 后仍未导航，则不存在半途 reLaunch", () => {
    const navigateToStart = vi.fn();
    const nav = createStartupNav({ navigateToStart });

    nav.requestStart();
    nav.clearStart(); // 认证失败撤销
    nav.markPageMounted();
    nav.clearStart(); // 重入的 effect 再次撤销
    expect(navigateToStart).not.toHaveBeenCalled();
    expect(nav.navigated).toBe(false);
  });

  it("导航后再次 markPageMounted / requestStart 不再触发", () => {
    const navigateToStart = vi.fn();
    const nav = createStartupNav({ navigateToStart });

    nav.markPageMounted();
    nav.requestStart();
    expect(navigateToStart).toHaveBeenCalledOnce();

    nav.requestStart();
    nav.markPageMounted();
    expect(navigateToStart).toHaveBeenCalledOnce();
  });
});
