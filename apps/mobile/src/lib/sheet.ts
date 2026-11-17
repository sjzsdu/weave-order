/**
 * 底部弹层与 tabbar 的互斥控制。
 *
 * tabbar 不在页面栈里：H5 是 `.taro-tabbar__tabbar`（`.weui-tabbar` z-index 500），
 * 小程序是原生组件。而弹层挂在 `.taro_page` 内部，该容器带 `transform` 与
 * `z-index: 0`，自己就是一个层叠上下文——弹层里的 z-index 再高也只在页面这一层
 * 比较，永远盖不住 tabbar（WAN-161 的真因，实测「保存」按钮命中 tabbar 图标）。
 * 所以打开弹层时收起 tabbar、全部关闭后恢复，这是唯一跨端一致的做法。
 */
export interface TabBarApi {
  hide: () => Promise<unknown>;
  show: () => Promise<unknown>;
}

export interface SheetTabBarController {
  /** 每打开一个弹层调用一次；返回释放函数，重复调用无效。 */
  acquire: () => () => void;
}

export function createSheetTabBarController(tabBar: TabBarApi): SheetTabBarController {
  let openCount = 0;
  let hidden = false;
  // hide/show 串行执行：快速开关弹层时不会出现 show 先于 hide 落地。
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>): void => {
    queue = queue.then(task).catch(() => {
      // tabbar 操作失败不能阻断弹层本身（例如非 tabbar 页面调用会 reject）。
    });
  };

  const hide = async (): Promise<void> => {
    if (hidden) return;
    try {
      await tabBar.hide();
      hidden = true;
    } catch {
      // 非 tabbar 页面没有可收起的 tabbar：保持 hidden=false，释放时也不会误 show。
    }
  };

  const show = async (): Promise<void> => {
    if (!hidden) return;
    try {
      await tabBar.show();
      hidden = false;
    } catch {
      // 恢复失败时下一次 acquire 会重新 hide，不做额外补偿。
    }
  };

  return {
    acquire() {
      openCount += 1;
      enqueue(hide);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        openCount = Math.max(0, openCount - 1);
        if (openCount > 0) return;
        enqueue(show);
      };
    },
  };
}
