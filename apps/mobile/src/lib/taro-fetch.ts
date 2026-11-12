import Taro from "@tarojs/taro";

/**
 * 小程序 / RN 没有 DOM fetch：用 Taro.request 适配 core 的 fetch 形状。
 * 只实现 core 用到的 `ok / status / text()`，不假装完整 Response。
 */
export interface MinimalResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type MinimalFetch = (input: string, init?: RequestInit) => Promise<MinimalResponse>;

export function createTaroFetch(): MinimalFetch {
  return async (input, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers =
      init.headers && !Array.isArray(init.headers) ? (init.headers as Record<string, string>) : {};
    let data: unknown = init.body;
    if (typeof data === "string" && headers["Content-Type"] === "application/json") {
      try {
        data = JSON.parse(data);
      } catch {
        // 保持原样交给服务端报 400。
      }
    }
    const response = await Taro.request({
      url: input,
      method: method as "GET",
      data: data as string | Record<string, unknown> | undefined,
      header: headers,
      dataType: "text",
    });
    const text =
      typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? null);
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      text: () => Promise.resolve(text),
    };
  };
}

export function hasDomFetch(): boolean {
  return typeof fetch === "function";
}
