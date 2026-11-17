import Taro from "@tarojs/taro";
import { createSheetTabBarController } from "./sheet";

/** Taro 适配层：真正的 hide/show 调用放在这里，纯控制器（sheet.ts）保持可单测。 */
export const sheetTabBar = createSheetTabBarController({
  hide: () => Taro.hideTabBar({ animation: false }),
  show: () => Taro.showTabBar({ animation: false }),
});
