import type { MockState, MockStorage } from "./types";

/** 同步键值存储（H5 localStorage / 小程序 Taro.getStorageSync / 测试内存）。 */
export function createStringMockStorage(
  read: () => string | null,
  write: (value: string | null) => void,
): MockStorage {
  return {
    load() {
      const raw = read();
      if (!raw) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return null;
        const state = parsed as Partial<MockState>;
        if (!Array.isArray(state.quotes) || !Array.isArray(state.approvals)) return null;
        return {
          quotes: state.quotes,
          approvals: state.approvals,
          revisions: state.revisions ?? [],
          shares: state.shares ?? [],
          audit: state.audit ?? [],
          seq: state.seq ?? 1,
          offline: state.offline ?? false,
        };
      } catch {
        return null;
      }
    },
    save(state) {
      write(JSON.stringify(state));
    },
    clear() {
      write(null);
    },
  };
}

export function createMemoryMockStorage(seed?: MockState): MockStorage {
  let raw: string | null = seed ? JSON.stringify(seed) : null;
  return createStringMockStorage(
    () => raw,
    (value) => {
      raw = value;
    },
  );
}
