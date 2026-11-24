import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UndoToast } from "../../../packages/ui/src/undo-toast";

const effects = vi.hoisted(() => ({ cleanups: [] as Array<(() => void) | void> }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => (() => void) | void) => {
    effects.cleanups.push(effect());
  },
}));
afterEach(() => {
  effects.cleanups.forEach((cleanup) => cleanup?.());
  effects.cleanups.length = 0;
  vi.useRealTimers();
});

describe("UndoToast", () => {
  it("成功提示提供撤销按钮，5 秒时关闭，4999ms 时仍在", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const html = renderToStaticMarkup(
      <UndoToast message="事项状态已更新" onUndo={() => {}} onDismiss={onDismiss} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("撤销");
    vi.advanceTimersByTime(4999);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("点击撤销调用对应动作，提交时不可重复点击", () => {
    const onUndo = vi.fn();
    const tree = UndoToast({
      message: "已更新",
      pending: true,
      onUndo,
      onDismiss: vi.fn(),
    }) as ReactElement<{ children: ReactElement<{ disabled?: boolean; onClick: () => void }>[] }>;
    const button = tree.props.children[1]!;
    expect(button.props.disabled).toBe(true);
    button.props.onClick();
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it("卸载清理计时器，不关闭后续的提示", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    renderToStaticMarkup(<UndoToast message="已更新" onUndo={vi.fn()} onDismiss={onDismiss} />);
    effects.cleanups[0]?.();
    vi.advanceTimersByTime(5000);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
