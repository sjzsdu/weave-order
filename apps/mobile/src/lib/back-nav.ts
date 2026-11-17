/**
 * 二级页返回动作决策（纯逻辑，不依赖 Taro，便于回归测试）。
 *
 * Taro H5 在「直接打开二级页」或 PWA 冷启动时页面栈只有当前一页，
 * navigateBack 无处可去；此时必须回退到 tab 首页，否则安装成 PWA 后
 * 用户没有浏览器返回按钮也没有手势，会被永久困住。
 */

export type BackAction<T extends string = string> = { kind: "back" } | { kind: "tab"; url: T };

export function resolveBackAction<T extends string>(
  stackDepth: number,
  fallbackTab: T,
): BackAction<T> {
  return stackDepth > 1 ? { kind: "back" } : { kind: "tab", url: fallbackTab };
}
