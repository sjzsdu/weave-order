import Taro from "@tarojs/taro";

/** 复制链接：优先 Taro（小程序 / App），H5 退到 Clipboard API。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await Taro.setClipboardData({ data: text });
    return true;
  } catch {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}
