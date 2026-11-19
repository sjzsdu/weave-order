import Taro from "@tarojs/taro";
import { IS_H5 } from "./runtime";

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

export type ClipboardRead =
  { ok: true; text: string } | { ok: false; reason: "unsupported" | "denied" | "empty" };

/**
 * 读取剪贴板。
 *
 * 只在用户点击后调用：H5 的 `navigator.clipboard.readText()` 要求手势 + 授权，
 * 页面加载时静默读取会被浏览器直接拒绝。失败一律归类成可读原因，
 * 调用方据此给提示，不把浏览器的英文异常抛给用户。
 */
export async function readClipboardText(): Promise<ClipboardRead> {
  if (IS_H5) {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      return { ok: false, reason: "unsupported" };
    }
    try {
      const text = (await navigator.clipboard.readText()).trim();
      return text ? { ok: true, text } : { ok: false, reason: "empty" };
    } catch {
      return { ok: false, reason: "denied" };
    }
  }
  try {
    const result = await Taro.getClipboardData();
    const text = (result.data ?? "").trim();
    return text ? { ok: true, text } : { ok: false, reason: "empty" };
  } catch {
    return { ok: false, reason: "unsupported" };
  }
}

/** 转发：系统分享面板可用就走它，否则退回复制。两者都失败时明确返回 false。 */
export async function shareText(text: string, title = "报价单"): Promise<boolean> {
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ title, text, url: text });
      return true;
    } catch {
      // 用户取消或浏览器拒绝：继续尝试复制，保证还有一条出口。
    }
  }
  return copyText(text);
}
