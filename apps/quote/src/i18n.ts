export type Lang = "zh" | "en";

export interface Dict {
  brand: string;
  quoteFor: string;
  quoteNo: string;
  issuedBy: string;
  validUntil: string;
  remaining: (days: number) => string;
  expired: string;
  lineItem: string;
  qty: string;
  unitPrice: string;
  lineTotal: string;
  subtotal: string;
  total: string;
  accept: string;
  acceptTitle: string;
  phoneTail: string;
  phoneTailPlaceholder: string;
  phoneTailHint: string;
  confirmAccept: string;
  cancel: string;
  accepting: string;
  accepted: string;
  acceptedAt: (date: string) => string;
  acceptNote: string;
  askTitle: string;
  askHint: string;
  askPlaceholder: string;
  askLine: string;
  askAll: string;
  askSubmit: string;
  asking: string;
  askDone: string;
  downloadPdf: string;
  termsTitle: string;
  termsFallback: string;
  watermark: string;
  invalidTitle: string;
  invalidBody: string;
  expiredTitle: string;
  expiredBody: string;
  revokedTitle: string;
  revokedBody: string;
  unavailableTitle: string;
  unavailableBody: string;
  pdfDisabled: string;
  contactSales: string;
  wechatQr: string;
  offerNote: string;
  retry: string;
  language: string;
  backToQuote: string;
  printTitle: string;
  printHint: string;
  printButton: string;
}

const ZH: Dict = {
  brand: "报价单",
  quoteFor: "致",
  quoteNo: "报价编号",
  issuedBy: "报价方",
  validUntil: "有效期至",
  remaining: (days) => `剩余 ${days} 天`,
  expired: "已过期",
  lineItem: "面料 / 规格",
  qty: "数量",
  unitPrice: "单价",
  lineTotal: "金额",
  subtotal: "小计",
  total: "合计（含税）",
  accept: "接受此报价",
  acceptTitle: "确认接受报价",
  phoneTail: "联系人手机尾号后 4 位",
  phoneTailPlaceholder: "后 4 位",
  phoneTailHint: "用于确认您是这单的联系人，不做注册、不留明文。",
  confirmAccept: "确认接受",
  cancel: "取消",
  accepting: "提交中…",
  accepted: "已记录成交意向",
  acceptedAt: (date) => `接受时间：${date}`,
  acceptNote: "接受仅为成交意向，业务员确认后才会转订单草稿；本页不构成合同。",
  askTitle: "有疑问，留言",
  askHint: "可以针对某一行提问，业务员会尽快回复。",
  askPlaceholder: "例如：这个克重有没有更厚的？",
  askLine: "针对哪一行",
  askAll: "整单提问",
  askSubmit: "发送留言",
  asking: "发送中…",
  askDone: "留言已发送，业务员会尽快回复。",
  downloadPdf: "下载 PDF",
  termsTitle: "条款",
  termsFallback: "本报价为要约邀请，价格与交期以业务员最终确认为准。",
  watermark: "客户专属",
  invalidTitle: "链接无效",
  invalidBody: "这个报价链接不存在或已被替换，请联系您的业务员重新获取。",
  expiredTitle: "报价已过期",
  expiredBody: "这条报价已超过有效期，请联系您的业务员获取最新报价。",
  revokedTitle: "链接已撤回",
  revokedBody: "业务员已撤回这条报价链接。如有疑问，请直接联系业务员。",
  unavailableTitle: "暂时无法打开报价",
  unavailableBody: "服务正在恢复中，这条链接本身没有失效。请稍后刷新重试。",
  pdfDisabled: "该报价未开放 PDF 下载。",
  contactSales: "联系业务员",
  wechatQr: "微信二维码",
  offerNote: "本报价为要约邀请，接受后由业务员确认订单。",
  retry: "重试",
  language: "EN",
  backToQuote: "返回报价",
  printTitle: "报价单打印预览",
  printHint: "在打印对话框中选择「另存为 PDF」。",
  printButton: "打印 / 保存 PDF",
};

const EN: Dict = {
  brand: "Quotation",
  quoteFor: "For",
  quoteNo: "Quote no.",
  issuedBy: "From",
  validUntil: "Valid until",
  remaining: (days) => `${days} day${days === 1 ? "" : "s"} left`,
  expired: "Expired",
  lineItem: "Fabric / spec",
  qty: "Qty",
  unitPrice: "Unit price",
  lineTotal: "Amount",
  subtotal: "Subtotal",
  total: "Total (incl. tax)",
  accept: "Accept this quotation",
  acceptTitle: "Confirm acceptance",
  phoneTail: "Last 4 digits of contact phone",
  phoneTailPlaceholder: "Last 4 digits",
  phoneTailHint: "Only used to confirm you are the contact on this quote. No signup.",
  confirmAccept: "Confirm",
  cancel: "Cancel",
  accepting: "Submitting…",
  accepted: "Intent to proceed recorded",
  acceptedAt: (date) => `Accepted at ${date}`,
  acceptNote:
    "Acceptance only records intent. Your salesperson confirms it and creates the order draft; this page is not a contract.",
  askTitle: "Questions? Leave a message",
  askHint: "Ask about a specific line and your salesperson will reply.",
  askPlaceholder: "e.g. Do you have a heavier weight of this fabric?",
  askLine: "About",
  askAll: "Whole quote",
  askSubmit: "Send message",
  asking: "Sending…",
  askDone: "Message sent. Your salesperson will reply shortly.",
  downloadPdf: "Download PDF",
  termsTitle: "Terms",
  termsFallback:
    "This quotation is an invitation to offer. Prices and lead times are subject to final confirmation.",
  watermark: "Customer copy",
  invalidTitle: "Invalid link",
  invalidBody:
    "This quote link does not exist or has been replaced. Please contact your salesperson.",
  expiredTitle: "Quotation expired",
  expiredBody:
    "This quotation is past its validity date. Please ask your salesperson for an update.",
  revokedTitle: "Link withdrawn",
  revokedBody: "Your salesperson has withdrawn this quote link. Please contact them directly.",
  unavailableTitle: "Quotation temporarily unavailable",
  unavailableBody:
    "The service is recovering; this link has not been invalidated. Please refresh and try again shortly.",
  pdfDisabled: "PDF download is not enabled for this quotation.",
  contactSales: "Contact salesperson",
  wechatQr: "WeChat QR code",
  offerNote: "This quotation is an invitation to offer; your salesperson confirms the order.",
  retry: "Retry",
  language: "中文",
  backToQuote: "Back to quote",
  printTitle: "Quotation print preview",
  printHint: "Choose “Save as PDF” in the print dialog.",
  printButton: "Print / Save as PDF",
};

export function dict(lang: Lang): Dict {
  return lang === "en" ? EN : ZH;
}

export function nextLang(lang: Lang): Lang {
  return lang === "en" ? "zh" : "en";
}
