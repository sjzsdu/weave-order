import { headers } from "next/headers";
import { PublicSampleCard } from "@weave-order/schema";

/**
 * 样卡扫码页的 SSR 读取。
 *
 * 与报价页同一套公开面：服务端直连 API，把访客 IP / UA 透传过去做限流。
 * 返回的数据只有样品编号与业务员联系方式——这是契约，不是约定。
 */
export type SampleCardResult =
  { ok: true; data: PublicSampleCard } | { ok: false; message: string };

export async function fetchSampleCard(token: string): Promise<SampleCardResult> {
  const apiBase = process.env.QUOTE_API_BASE_URL ?? "http://localhost:3000";
  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for") ?? incoming.get("x-real-ip") ?? "";
  const userAgent = incoming.get("user-agent") ?? "weave-sample-ssr";

  try {
    const response = await fetch(
      `${apiBase}/api/public/sample-cards/${encodeURIComponent(token)}`,
      {
        cache: "no-store",
        headers: {
          "x-forwarded-for": forwarded,
          "user-agent": userAgent,
        },
      },
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const candidate = body as { error?: { message?: string } } | null;
      return {
        ok: false,
        message: candidate?.error?.message ?? "链接无效，请扫描样卡上的二维码",
      };
    }
    const payload = body as { data: unknown };
    return { ok: true, data: PublicSampleCard.parse(payload.data) };
  } catch {
    return { ok: false, message: "暂时无法加载，请稍后重试" };
  }
}
