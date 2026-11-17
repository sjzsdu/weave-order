import { describe, expect, it, vi } from "vitest";
import { createSheetTabBarController } from "../src/lib/sheet";

/**
 * WAN-161 回归：底部弹层必须能在 tabbar 页面上正常操作。
 *
 * tabbar 与页面栈是兄弟节点，`.taro_page` 自带层叠上下文，弹层提高 z-index 也盖不住
 * tabbar；因此弹层打开期间收起 tabbar、全部关闭后恢复。这里固定控制器的不变式：
 * 收起/恢复成对、并发弹层只操作一次、非 tabbar 页面不误恢复。
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { hideFails?: boolean } = {}) {
  const hide = vi.fn(() =>
    options.hideFails ? Promise.reject(new Error("not TabBar page")) : Promise.resolve(),
  );
  const show = vi.fn(() => Promise.resolve());
  return { hide, show, controller: createSheetTabBarController({ hide, show }) };
}

describe("底部弹层与 tabbar 的互斥", () => {
  it("打开收起 tabbar，关闭恢复", async () => {
    const { hide, show, controller } = setup();
    const release = controller.acquire();
    await flush();
    expect(hide).toHaveBeenCalledOnce();
    expect(show).not.toHaveBeenCalled();

    release();
    await flush();
    expect(show).toHaveBeenCalledOnce();
  });

  it("多个弹层同时打开：只收起一次，最后一个关闭才恢复", async () => {
    const { hide, show, controller } = setup();
    const releaseFirst = controller.acquire();
    const releaseSecond = controller.acquire();
    await flush();
    expect(hide).toHaveBeenCalledOnce();

    releaseFirst();
    await flush();
    expect(show).not.toHaveBeenCalled();

    releaseSecond();
    await flush();
    expect(show).toHaveBeenCalledOnce();
  });

  it("非 tabbar 页面（hide 失败）关闭时不会误调用 show", async () => {
    const { show, controller } = setup({ hideFails: true });
    const release = controller.acquire();
    await flush();
    release();
    await flush();
    expect(show).not.toHaveBeenCalled();
  });

  it("hide 尚未完成就关闭，最终仍会恢复 tabbar", async () => {
    let resolveHide: (() => void) | undefined;
    const hide = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHide = resolve;
        }),
    );
    const show = vi.fn(() => Promise.resolve());
    const controller = createSheetTabBarController({ hide, show });

    const release = controller.acquire();
    release(); // hide 还在途中就关闭
    await flush();
    expect(show).not.toHaveBeenCalled(); // 串行：必须等 hide 落地
    resolveHide?.();
    await flush();
    await flush();
    expect(show).toHaveBeenCalledOnce();
  });

  it("重复调用释放函数只恢复一次", async () => {
    const { show, controller } = setup();
    const release = controller.acquire();
    await flush();
    release();
    release();
    await flush();
    expect(show).toHaveBeenCalledOnce();
  });
});
