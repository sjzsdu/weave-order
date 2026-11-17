/**
 * 会话令牌的存放与恢复。
 *
 * 令牌写 sessionStorage：既能跨「OIDC 回调页 → 应用页」的整页导航、
 * 也能跨刷新存活，又只限当前标签页，关掉标签即失效（比 localStorage 的
 * 暴露窗口更小）。内存变量只是热路径缓存，读写都以存储为准。
 *
 * 单独成模块是为了让 OIDC 流程与运行时装配层互不循环依赖：
 * oidc.ts 只依赖这里，runtime.ts 从这里 re-export 并依赖 oidc.ts。
 */

export const TOKEN_KEY = "weave.session.token";

let memoryToken: string | null = null;
let loaded = false;

function sessionStorageOrNull(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    // 隐私模式 / 禁用存储时访问会抛异常，退化为纯内存。
    return null;
  }
}

/** 启动时同步恢复，保证首个业务请求就带上 Authorization。 */
function loadFromStorage(): void {
  if (loaded) return;
  loaded = true;
  const token = sessionStorageOrNull()?.getItem(TOKEN_KEY) ?? null;
  if (token) memoryToken = token;
}

loadFromStorage();

export function setAuthToken(token: string | null): void {
  memoryToken = token;
  loaded = true;
  const storage = sessionStorageOrNull();
  if (!storage) return;
  try {
    if (token) storage.setItem(TOKEN_KEY, token);
    else storage.removeItem(TOKEN_KEY);
  } catch {
    // 存储配额满 / 只读存储：内存令牌仍可完成本次页面生命周期内的请求。
  }
}

export function getAuthToken(): string | null {
  // 惰性再读一次：测试里 resetModules 或同页多实例时也能看到对方写入的令牌。
  if (!loaded) loadFromStorage();
  return memoryToken ?? sessionStorageOrNull()?.getItem(TOKEN_KEY) ?? null;
}
