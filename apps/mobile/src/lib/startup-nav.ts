/**
 * 移动端启动导航协调器（纯逻辑，不依赖 React / Taro，便于回归测试）。
 *
 * 背景（Taro H5 "没有找到页面实例"）：
 *   setAuthReady(true) 只调度 React 更新，不代表首屏 Page 已挂载。若在 children
 *   挂载前调用 Taro.reLaunch，@tarojs/runtime 找不到当前页面实例并抛错。
 *
 * 不变式：
 *   1. 只有「首屏页面已挂载」且「已判定需要创建公司」两个条件同时成立才导航；
 *   2. 两个信号的到达顺序无关（先请求后挂载、或先挂载后请求都能正确导航）；
 *   3. 导航至多执行一次（effect 重入 / 重复渲染不会二次 reLaunch）；
 *   4. 可恢复：未导航前撤销请求（如 api.me 失败）后，仍可在后续重试中导航。
 *
 * 不使用任何 setTimeout 掩盖竞态——只用明确的 ready 状态协调。
 */

export interface StartupNavOptions {
  /** 真正执行创建公司页导航（生产接线为 openStart → Taro.reLaunch）。 */
  navigateToStart: () => void;
}

export interface StartupNavController {
  /** 首屏 children/Page 已完成挂载（由 React 挂载 effect 调用）。 */
  markPageMounted(): void;
  /** 认证完成，且判定为新注册用户（NO_MEMBERSHIP），需要创建公司。 */
  requestStart(): void;
  /** 撤销导航请求：已有公司、认证失败或 api.me 异常时调用。 */
  clearStart(): void;
  readonly pageMounted: boolean;
  readonly startRequested: boolean;
  readonly navigated: boolean;
}

export function createStartupNav(options: StartupNavOptions): StartupNavController {
  let pageMounted = false;
  let startRequested = false;
  let navigated = false;

  const maybeNavigate = (): void => {
    if (navigated || !pageMounted || !startRequested) return;
    navigated = true;
    options.navigateToStart();
  };

  return {
    markPageMounted() {
      pageMounted = true;
      maybeNavigate();
    },
    requestStart() {
      startRequested = true;
      maybeNavigate();
    },
    clearStart() {
      startRequested = false;
    },
    get pageMounted() {
      return pageMounted;
    },
    get startRequested() {
      return startRequested;
    },
    get navigated() {
      return navigated;
    },
  };
}
