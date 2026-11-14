import { getAuthToken, setAuthToken } from "./session";

/**
 * 移动端 H5/PWA 的 OIDC Authorization Code + PKCE。
 *
 * 与租户端 Web 的区别：这里没有服务端 BFF，**不能持有 client_secret**，
 * 所以走 public PKCE（code_verifier 换 token），令牌只驻留内存，刷新即重新登录。
 * 小程序 / RN 端不启用（TARO_ENV 分支只在这里出现一次）。
 *
 * 配置由托管层在 HTML 里注入 `window.__WEAVE_CONFIG__`（见 scripts/serve-static.mjs
 * 的 --runtime-config），换域名不用重发镜像；没有注入时不启用登录门禁，
 * 本地 demo / 单元测试照常跑。
 */

export interface WeaveRuntimeConfig {
  apiBase?: string;
  issuer?: string;
  clientId?: string;
  redirectUri?: string;
}

declare global {
  interface Window {
    __WEAVE_CONFIG__?: WeaveRuntimeConfig;
  }
}

interface AuthConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
}

const IS_H5 = process.env.TARO_ENV === "h5";
const STATE_KEY = "weave.oidc.state";
const VERIFIER_KEY = "weave.oidc.verifier";

let redirecting = false;
let lastError: string | null = null;

export function runtimeConfig(): WeaveRuntimeConfig {
  if (typeof window === "undefined") return {};
  return window.__WEAVE_CONFIG__ ?? {};
}

export function authConfig(): AuthConfig | null {
  const config = runtimeConfig();
  if (!config.issuer || !config.clientId || !config.redirectUri) return null;
  return {
    issuer: config.issuer.replace(/\/$/, ""),
    clientId: config.clientId,
    redirectUri: config.redirectUri,
  };
}

/** 只有生产 H5 且托管层注入了完整 OIDC 配置时才强制登录。 */
export function isAuthRequired(): boolean {
  return IS_H5 && process.env.NODE_ENV === "production" && authConfig() !== null;
}

export function getAuthError(): string | null {
  return lastError;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLength: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(digest));
}

/** 整页跳到 Casdoor 授权端点；PKCE 参数暂存在 sessionStorage（不是令牌）。 */
export function startLogin(): void {
  if (redirecting || !IS_H5 || typeof window === "undefined") return;
  const config = authConfig();
  const storage = browserStorage();
  if (!config || !storage) return;

  redirecting = true;
  lastError = null;
  void (async () => {
    const state = randomString(24);
    const verifier = randomString(48);
    const challenge = await sha256Base64Url(verifier);
    storage.setItem(STATE_KEY, state);
    storage.setItem(VERIFIER_KEY, verifier);

    const authorize = new URL(`${config.issuer}/login/oauth/authorize`);
    authorize.searchParams.set("client_id", config.clientId);
    authorize.searchParams.set("redirect_uri", config.redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "openid profile email");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    window.location.replace(authorize.toString());
  })().catch(() => {
    redirecting = false;
    lastError = "无法打开统一登录页，请检查网络后重试";
  });
}

function isCallbackUrl(): boolean {
  if (typeof window === "undefined") return false;
  return new URL(window.location.href).pathname === "/auth/callback";
}

/** 清掉地址栏里的 code/state，避免刷新重放或被 Service Worker 缓存。 */
function cleanCallbackUrl(): void {
  try {
    window.history.replaceState(null, "", "/");
  } catch {
    // 部分 WebView 不允许改历史，忽略即可。
  }
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  data?: { id_token?: string; access_token?: string };
  error?: string;
  error_description?: string;
}

/**
 * 处理 /auth/callback：校验 state → 用 code + verifier 换 token → 写入内存会话。
 * 不经过 runtime 的 fetch 包装，避免 401 递归触发登录跳转。
 */
export async function handleCallback(): Promise<boolean> {
  if (!IS_H5 || typeof window === "undefined" || !isCallbackUrl()) return false;
  const config = authConfig();
  const storage = browserStorage();
  if (!config || !storage) return false;

  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = storage.getItem(STATE_KEY);
  const verifier = storage.getItem(VERIFIER_KEY);
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");

  cleanCallbackUrl();
  storage.removeItem(STATE_KEY);
  storage.removeItem(VERIFIER_KEY);

  if (error) {
    lastError = error;
    return false;
  }
  if (!code || !state || !expectedState || state !== expectedState || !verifier) {
    lastError = "登录校验未通过（state 不匹配或缺少授权码），请重新登录";
    return false;
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });

  try {
    const response = await fetch(`${config.issuer}/api/login/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form,
    });
    const body = (await response.json()) as TokenResponse;
    const token =
      body.id_token ?? body.data?.id_token ?? body.access_token ?? body.data?.access_token;
    if (!response.ok || !token) {
      lastError = body.error_description ?? body.error ?? "统一登录未返回有效令牌，请重新登录";
      return false;
    }
    setAuthToken(token);
    lastError = null;
    return true;
  } catch {
    lastError = "无法连接统一登录服务，请检查网络后重试";
    return false;
  }
}

/**
 * 启动门禁：已登录 → 放行；回调 → 换 token；否则 → 跳登录。
 * 回调失败时**不再自动重跳**，避免「授权失败 → 再授权 → 再失败」死循环，
 * 由页面展示错误和一个手动重试入口。
 */
export async function ensureAuthenticated(): Promise<boolean> {
  if (!isAuthRequired()) return true;
  if (getAuthToken()) return true;
  if (isCallbackUrl()) return handleCallback();

  startLogin();
  return false;
}

/** 业务请求 401：清空内存令牌并重新登录（同一次页面生命周期只跳一次）。 */
export function onUnauthorized(): void {
  if (!isAuthRequired()) return;
  setAuthToken(null);
  startLogin();
}
