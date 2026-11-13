import { BoxQrPayload } from "@weave-order/schema";
import type { DocumentView, OrderBox } from "@weave-order/schema";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 一箱一码：tenant/order/box/seq。不含价格，外部无法从码里读到商业信息。
 * boxNo 只允许字母数字与连字符，避免斜杠破坏分隔。
 */
export function buildBoxQr(input: {
  tenantId: string;
  orderId: string;
  boxNo: string;
  seq: number;
}): string {
  return `${input.tenantId}/${input.orderId}/${input.boxNo}/${input.seq}`;
}

export function parseBoxQr(raw: string): BoxQrPayload | null {
  const parts = raw.trim().split("/");
  if (parts.length !== 4) return null;
  const [tenantId, orderId, boxNo, seqText] = parts;
  if (!tenantId || !orderId || !boxNo || !seqText) return null;
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(orderId)) return null;
  if (!/^[A-Za-z0-9-]{1,32}$/.test(boxNo)) return null;
  const seq = Number(seqText);
  if (!Number.isInteger(seq) || seq < 1) return null;
  return BoxQrPayload.parse({ tenantId, orderId, boxNo, seq });
}

/** 箱唛视图：从发货单视图里剥出单箱字段，模板仍只能看到白名单。 */
export function boxView(
  view: DocumentView,
  box: Pick<OrderBox, "boxNo" | "seq" | "quantity" | "grossWeightKg" | "size"> & {
    qr?: string;
  },
): DocumentView {
  return {
    ...view,
    kind: "BOX_LABEL",
    title: "箱唛",
    boxes: [
      {
        boxNo: box.boxNo,
        seq: box.seq,
        qr: box.qr ?? "",
        quantity: box.quantity,
        itemCount: 0,
        grossWeightKg: box.grossWeightKg,
        size: box.size,
      },
    ],
  };
}
