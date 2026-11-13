import Taro from "@tarojs/taro";

/**
 * 只缓存「今日待办 / 待批单据 / 客户列表」这类只读快照，
 * 弱网打开先展示上次结果并明确标注「离线缓存」。
 * 不缓存 token、成本、毛利。
 */

interface CacheEntry<T> {
  savedAt: string;
  data: T;
}

const PREFIX = "weave.cache.";

export function readCache<T>(key: string): { data: T; savedAt: string } | null {
  try {
    const raw: unknown = Taro.getStorageSync(`${PREFIX}${key}`);
    if (typeof raw !== "string" || !raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const entry = parsed as Partial<CacheEntry<T>>;
    if (typeof entry.savedAt !== "string" || entry.data === undefined) return null;
    return { data: entry.data, savedAt: entry.savedAt };
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T): void {
  try {
    Taro.setStorageSync(
      `${PREFIX}${key}`,
      JSON.stringify({ savedAt: new Date().toISOString(), data }),
    );
  } catch {
    // 配额满时放弃缓存，不影响在线主流程。
  }
}
