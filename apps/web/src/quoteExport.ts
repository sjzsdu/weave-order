import type { QuoteSendRecord } from "@weave-order/schema";

/**
 * 报价出口的前端入口（阶段一）。
 *
 * 只有两个动作：导出 PDF（后端渲染并写发送记录）、读发送记录。
 * 记账发生在后端：前端拿到的是文件字节，不是「发送成功」的自我声明。
 */

async function errorOf(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { message?: string; code?: string };
    if (body.message) return new Error(body.message);
    if (body.code) return new Error(body.code);
  } catch {
    // 响应不是 JSON，退回 HTTP 状态描述。
  }
  return new Error(`HTTP ${response.status} ${response.statusText}`);
}

export interface ExportQuoteOptions {
  /** 发给谁：客户联系人 / 微信 / 邮箱，可留空。 */
  recipient?: string;
  note?: string;
}

/** 导出 PDF 并在后端写一条发送记录；成功后浏览器直接下载文件。 */
export async function exportQuotePdf(
  quoteId: string,
  options: ExportQuoteOptions = {},
): Promise<void> {
  const response = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(options.recipient?.trim() ? { recipient: options.recipient.trim() } : {}),
      ...(options.note?.trim() ? { note: options.note.trim() } : {}),
    }),
  });
  if (!response.ok) throw await errorOf(response);

  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const matched = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = matched?.[1] ?? `quotation-${quoteId.slice(0, 8)}.pdf`;

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 某份报价的发送记录（最新在前）。空数组 = 从未发出去过。 */
export async function listQuoteSends(quoteId: string): Promise<QuoteSendRecord[]> {
  const response = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/exports`);
  if (!response.ok) throw await errorOf(response);
  const body = (await response.json()) as { sends: QuoteSendRecord[] };
  return body.sends;
}
