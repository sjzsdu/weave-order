import type { ExportQuoteInput, QuoteDetail, QuoteSendRecord } from "@weave-order/schema";
import type { Kernel, KernelContext } from "../kernel";
import { loadQuoteCompany, loadQuoteTerms } from "./company";
import { quotePdfFilename, renderQuotePdf } from "./pdf";
import { buildQuoteDocumentSnapshot } from "./snapshot";

export interface QuoteExportResult {
  /** 客户可直接转发的报价单文件内容。 */
  bytes: Uint8Array;
  filename: string;
  /** 本次导出写入的发送记录（= 这次发送的一等实体）。 */
  send: QuoteSendRecord;
}

export interface QuoteExportService {
  /** 已确认报价的完整明细（只读，不限制状态）。 */
  detail(quoteId: string): Promise<QuoteDetail>;
  /**
   * 导出一份已确认报价并记录这次发送。
   * 顺序是「先渲染、后记账」：PDF 渲染失败不会留下一条“已发送”的假账。
   */
  exportQuote(
    quoteId: string,
    ctx: KernelContext,
    input: ExportQuoteInput,
    now?: Date,
  ): Promise<QuoteExportResult>;
  /** 某份报价的发送记录；空数组表示从未导出/发送过。 */
  listSends(quoteId: string): Promise<QuoteSendRecord[]>;
}

/**
 * 报价出口服务（导出层）。
 *
 * 职责边界：本层只做「把内核读出的账本内容渲染成客户可见文件」，
 * 不写任何业务表；发送记录一律经 `kernel.quotes.recordSend` 落账 + 写审计。
 */
export function createQuoteExportService(
  kernel: Kernel,
  options: { company?: ReturnType<typeof loadQuoteCompany>; terms?: string[] } = {},
): QuoteExportService {
  const company = options.company ?? loadQuoteCompany();
  const terms = options.terms ?? loadQuoteTerms();

  return {
    detail(quoteId) {
      return kernel.quotes.getDetail(quoteId);
    },

    async exportQuote(quoteId, ctx, input, now = new Date()) {
      const detail = await kernel.quotes.getDetail(quoteId);
      const snapshot = buildQuoteDocumentSnapshot({ detail, company, terms, generatedAt: now });
      const bytes = await renderQuotePdf(snapshot);
      const send = await kernel.quotes.recordSend(quoteId, ctx, {
        recipient: input.recipient ?? null,
        note: input.note ?? null,
        snapshot,
      });
      return { bytes, filename: quotePdfFilename(snapshot), send };
    },

    listSends(quoteId) {
      return kernel.quotes.listSends(quoteId);
    },
  };
}
