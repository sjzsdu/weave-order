import { KernelError } from "./errors";

/**
 * 列表分页游标：把「上一页最后一条」的位置编码进不透明字符串。
 *
 * 用游标而不是 offset，是为了在翻页期间有新增 / 审批动作时不会出现
 * 重复或漏单（offset 会随数据变化整体位移）。游标只承载排序键，
 * 不承载任何权限或业务字段，因此无需签名。
 */
const VERSION = 1;

export function encodeCursor(payload: Record<string, string | number | null>): string {
  return Buffer.from(JSON.stringify({ v: VERSION, ...payload }), "utf8").toString("base64url");
}

/**
 * 解码游标；格式不对一律 INVALID_INPUT（让前端刷新重来），
 * 而不是静默当成第一页——后者会表现为「翻页跳回开头」。
 */
export function decodeCursor(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not-object");
    const record = parsed as Record<string, unknown>;
    if (record.v !== VERSION) throw new Error("version");
    return record;
  } catch {
    throw invalidCursor();
  }
}

export function invalidCursor(): KernelError {
  return new KernelError("KERNEL_REJECTED", "分页游标无效，请刷新列表后重试", {
    reason: "INVALID_INPUT",
  });
}

/** 审批队列游标：排序键是 `createdAt DESC, id DESC`，下一页取严格更小的键。 */
export function parseApprovalCursor(
  raw: Record<string, unknown> | null,
): { createdAt: string; id: string } | null {
  if (!raw) return null;
  const { createdAt, id } = raw;
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw invalidCursor();
  if (typeof id !== "string" || id.length === 0) throw invalidCursor();
  return { createdAt, id };
}
