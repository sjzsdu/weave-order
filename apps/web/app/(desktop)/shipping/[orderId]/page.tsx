"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { OrderBox, ReprintReason, Shipment, ShipmentView } from "@weave-order/schema";
import { PrintDocumentKindLabel } from "@weave-order/schema";
import { Badge, Button, EmptyState, Spinner, cn } from "@weave-order/ui";
import {
  useCreateShipment,
  useOrder,
  useOrderShipments,
  usePrintShipmentBundle,
  useShipment,
  useShipShipment,
} from "@weave-order/core";
import { useApi } from "@/providers";
import { relativeTime } from "@/format";

const REPRINT_REASONS: Array<{ value: ReprintReason; label: string }> = [
  { value: "DAMAGED", label: "损坏" },
  { value: "LOST", label: "丢失" },
  { value: "CUSTOMER_REQUEST", label: "客户要求" },
  { value: "WRONG_PRINT", label: "打错" },
  { value: "OTHER", label: "其它" },
];

/**
 * 一单发货的真实流水线：建发货单 → 扫码拣货 → 建箱 → 一键打印 → 扫码复核 → 确认发货。
 * 页面入口来自工作台/打印中心的「待发货」，不新增一级导航。
 */
export default function ShippingPage() {
  const params = useParams<{ orderId: string }>();
  const orderId = params?.orderId ?? null;
  const api = useApi();
  const order = useOrder(api, orderId);
  const shipments = useOrderShipments(api, orderId);
  const createShipment = useCreateShipment(api);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const shipmentId = selectedId ?? shipments.data?.[0]?.id ?? null;
  const shipment = useShipment(api, shipmentId);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const data = shipment.data;

  function report(action: () => Promise<unknown>, success: string) {
    setError(null);
    setNotice(null);
    return action()
      .then(() => setNotice(success))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "操作失败"));
  }

  if (order.isLoading) return <div className="p-6 text-sm text-ink-400">正在读取订单…</div>;
  if (order.isError || !order.data) {
    return (
      <EmptyState
        title="找不到这张订单"
        description={order.error instanceof Error ? order.error.message : "请从工作台重新进入"}
        actions={
          <Link href="/today" className="text-sm text-indigo-600 underline underline-offset-2">
            回工作台
          </Link>
        }
      />
    );
  }

  const currentOrder = order.data;
  const allShipments: Shipment[] = shipments.data ?? [];
  const latest = allShipments[allShipments.length - 1];

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/today" className="text-xs text-ink-400 underline underline-offset-2">
            ← 回工作台
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">发货 · {currentOrder.code}</h1>
          <p className="mt-1 text-sm text-ink-400">
            {currentOrder.items.length} 个订单行 · 合计{" "}
            {(currentOrder.total.amount / 100).toFixed(2)} {currentOrder.currency} ·{" "}
            {currentOrder.status}
          </p>
        </div>
        {allShipments.length > 1 && (
          <label className="text-sm text-ink-700">
            发货单
            <select
              value={shipmentId ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
              className="ml-2 min-h-9 rounded-md border border-line bg-surface px-2 text-sm"
            >
              {allShipments.map((item, index) => (
                <option key={item.id} value={item.id}>
                  SH-{item.id.slice(0, 8).toUpperCase()} {index === 0 ? "（首单）" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {(error || notice) && (
        <p
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            error
              ? "border-vermilion-600/30 bg-vermilion-600/10 text-vermilion-600"
              : "border-moss-600/30 bg-moss-600/10 text-moss-600",
          )}
        >
          {error ?? notice}
        </p>
      )}

      {!latest ? (
        <CreateShipmentCard
          order={currentOrder}
          busy={createShipment.isPending}
          onCreate={async (input) => {
            setError(null);
            try {
              const result = await createShipment.mutateAsync({
                orderId: currentOrder.id,
                carrier: input.carrier,
                trackingNumber: input.trackingNumber,
                address: input.address,
                items: currentOrder.items.map((item) => ({
                  orderItemId: item.id,
                  quantity: { value: item.quantity.value, unit: item.quantity.unit },
                })),
              });
              setSelectedId(result.view.id);
              setNotice("发货单已建好：接着扫码拣货、建箱、一键打印。");
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "建发货单失败");
            }
          }}
        />
      ) : shipment.isLoading ? (
        <Spinner label="正在读取发货单…" />
      ) : data ? (
        <>
          <ShipmentHeader view={data} />
          <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
            <div className="grid gap-5">
              <PickCard
                sampleCodes={data.items.map((item) => item.sampleCode)}
                onScan={(code, quantity) =>
                  report(() => api.pickScan(data.id, { code, quantity }), "拣货扫描已记录")
                }
              />
              <BoxesCard
                view={data}
                onCreateBoxes={(count) =>
                  report(
                    () => api.createBoxes(data.id, { count, autoAssign: true }),
                    `已生成 ${count} 个箱号`,
                  )
                }
                onReprint={(box, reason) =>
                  report(() => api.reprintBox(box.id, reason), `箱 ${box.boxNo} 已补打，旧标签作废`)
                }
                onVoid={(box) =>
                  report(() => api.voidBox(box.id, "人工作废"), `箱 ${box.boxNo} 已作废`)
                }
                onResolve={(box, note) =>
                  report(
                    () => api.resolveDiscrepancy(box.id, note),
                    `箱 ${box.boxNo} 差异已核对，可以继续打印`,
                  )
                }
              />
            </div>
            <div className="grid gap-5">
              <PrintCard view={data} />
              <VerifyCard
                view={data}
                onScan={(boxQr, itemCode, quantity) =>
                  report(
                    () => api.verifyScan(data.id, { boxQr, itemCode, quantity }),
                    "复核扫描已记录",
                  )
                }
              />
              <ShipCard view={data} />
            </div>
          </div>
          <ScansCard view={data} />
        </>
      ) : (
        <EmptyState
          title="发货单读取失败"
          description={shipment.error instanceof Error ? shipment.error.message : "请稍后重试"}
        />
      )}
    </div>
  );
}

function CreateShipmentCard({
  order,
  busy,
  onCreate,
}: {
  order: { items: Array<{ description: string; quantity: { value: number; unit: string } }> };
  busy: boolean;
  onCreate: (input: { carrier: string; trackingNumber: string; address: string }) => Promise<void>;
}) {
  const [carrier, setCarrier] = useState("顺丰");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [address, setAddress] = useState("");
  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <h2 className="text-base font-semibold">建发货单</h2>
      <p className="mt-1 text-sm text-ink-400">
        按订单全部数量发货；分批发货可在后续版本按行拆分。
      </p>
      <ul className="mt-3 grid gap-1 text-sm text-ink-700">
        {order.items.map((item, index) => (
          <li key={index} className="flex justify-between border-b border-line/60 py-1">
            <span>{item.description}</span>
            <span>
              {item.quantity.value} {item.quantity.unit}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-ink-400">承运商</span>
          <input
            value={carrier}
            onChange={(event) => setCarrier(event.target.value)}
            className="mt-1 min-h-9 w-full rounded-md border border-line bg-paper px-2"
          />
        </label>
        <label className="text-sm">
          <span className="text-ink-400">运单号（可后补）</span>
          <input
            value={trackingNumber}
            onChange={(event) => setTrackingNumber(event.target.value)}
            className="mt-1 min-h-9 w-full rounded-md border border-line bg-paper px-2"
          />
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="text-ink-400">收货地址（发货单/箱唛必须）</span>
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            className="mt-1 min-h-9 w-full rounded-md border border-line bg-paper px-2"
          />
        </label>
      </div>
      <div className="mt-3">
        <Button
          variant="primary"
          disabled={busy || address.trim().length === 0}
          onClick={() =>
            void onCreate({
              carrier: carrier.trim(),
              trackingNumber: trackingNumber.trim(),
              address: address.trim(),
            })
          }
        >
          {busy ? "创建中…" : "创建发货单"}
        </Button>
      </div>
    </section>
  );
}

function ShipmentHeader({ view }: { view: ShipmentView }) {
  const blocked = view.printBlockedReason;
  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">
            SH-{view.id.slice(0, 8).toUpperCase()}
          </p>
          <h2 className="mt-1 text-lg font-semibold">
            {view.customerName} · {view.status}
          </h2>
          <p className="mt-1 text-sm text-ink-400">
            {view.address ?? "缺少收货地址"} · {view.carrier ?? "未选承运商"} ·{" "}
            {view.trackingNumber ?? "运单未填"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone="neutral">应发 {view.totalQuantity}</Badge>
          <Badge tone="neutral">已装 {view.boxQuantity}</Badge>
          <Badge tone="neutral">箱 {view.boxes.length}</Badge>
          {blocked === "DISCREPANCY" && <Badge tone="danger">先核对差异</Badge>}
          {blocked === "QUANTITY_MISMATCH" && <Badge tone="warning">箱数不一致</Badge>}
          {blocked === "NO_BOXES" && <Badge tone="warning">未建箱</Badge>}
        </div>
      </div>
      <div className="mt-3 grid gap-1 text-sm text-ink-700">
        {view.items.map((item) => (
          <div
            key={item.shipmentItemId}
            className="flex justify-between border-b border-line/60 py-1"
          >
            <span>
              {item.description}
              <span className="ml-2 text-xs text-ink-400">{item.sampleCode}</span>
            </span>
            <span>
              发 {item.quantity} / 订 {item.orderedQuantity} {item.unit}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function PickCard({
  sampleCodes,
  onScan,
}: {
  sampleCodes: string[];
  onScan: (code: string, quantity?: number) => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [quantity, setQuantity] = useState("1");
  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <h2 className="text-base font-semibold">① 扫码拣货</h2>
      <p className="mt-1 text-sm text-ink-400">扫样品码或手工输入；拣货量超过发货量会立即拦下。</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={`样品码，如 ${sampleCodes[0] ?? "FM-220"}`}
          className="min-h-9 flex-1 rounded-md border border-line bg-paper px-2 text-sm"
        />
        <input
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          inputMode="decimal"
          className="min-h-9 w-20 rounded-md border border-line bg-paper px-2 text-sm"
        />
        <Button
          onClick={() => void onScan(code.trim(), Number(quantity) || 1)}
          disabled={code.trim().length === 0}
        >
          记录拣货
        </Button>
      </div>
    </section>
  );
}

function BoxesCard({
  view,
  onCreateBoxes,
  onReprint,
  onVoid,
  onResolve,
}: {
  view: ShipmentView;
  onCreateBoxes: (count: number) => Promise<void>;
  onReprint: (box: OrderBox, reason: ReprintReason) => Promise<void>;
  onVoid: (box: OrderBox) => Promise<void>;
  onResolve: (box: OrderBox, note: string) => Promise<void>;
}) {
  const [count, setCount] = useState("2");
  const [reasons, setReasons] = useState<Record<string, ReprintReason>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">② 建箱 / 箱唛</h2>
          <p className="mt-1 text-sm text-ink-400">
            一箱一码（tenant/order/box/seq），补打必须选原因，旧标签立即作废。
          </p>
        </div>
        {view.boxes.length === 0 && (
          <div className="flex gap-2">
            <input
              value={count}
              onChange={(event) => setCount(event.target.value)}
              inputMode="numeric"
              className="min-h-9 w-16 rounded-md border border-line bg-paper px-2 text-sm"
            />
            <Button
              variant="primary"
              disabled={Number(count) < 1}
              onClick={() => void onCreateBoxes(Math.max(1, Math.floor(Number(count) || 1)))}
            >
              生成箱号
            </Button>
          </div>
        )}
      </div>

      {view.boxes.length === 0 ? (
        <p className="mt-4 rounded-md bg-paper px-3 py-4 text-sm text-ink-400">
          还没有箱号。输入箱数，系统会把实发明细平均分配到各箱，并生成二维码。
        </p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {view.boxes.map((box) => (
            <li key={box.id} className="rounded-md border border-line px-3 py-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-ink-900">
                    {box.boxNo}
                    <span className="ml-2 text-xs text-ink-400">
                      标签 #{box.seq} · {box.quantity} 件 · 已打 {box.printCount} 次
                    </span>
                  </p>
                  <p className="mt-0.5 break-all font-mono text-[11px] text-ink-400">{box.qr}</p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {box.items
                      .map((item) => `${item.description} ${item.quantity}${item.unit}`)
                      .join(" · ")}
                  </p>
                </div>
                <Badge
                  tone={
                    box.status === "VOIDED"
                      ? "neutral"
                      : box.hasDiscrepancy
                        ? "danger"
                        : box.status === "PACKED"
                          ? "success"
                          : "warning"
                  }
                >
                  {box.hasDiscrepancy ? "差异" : box.status === "PACKED" ? "已复核" : "待复核"}
                </Badge>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  value={reasons[box.id] ?? "DAMAGED"}
                  onChange={(event) =>
                    setReasons((prev) => ({
                      ...prev,
                      [box.id]: event.target.value as ReprintReason,
                    }))
                  }
                  className="min-h-8 rounded-md border border-line bg-paper px-2 text-xs"
                >
                  {REPRINT_REASONS.map((reason) => (
                    <option key={reason.value} value={reason.value}>
                      补打：{reason.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void onReprint(box, reasons[box.id] ?? "DAMAGED")}
                  className="text-xs text-indigo-600 underline underline-offset-2"
                >
                  补打箱唛
                </button>
                {box.hasDiscrepancy && (
                  <>
                    <input
                      value={notes[box.id] ?? ""}
                      onChange={(event) =>
                        setNotes((prev) => ({ ...prev, [box.id]: event.target.value }))
                      }
                      placeholder="核对说明"
                      className="min-h-8 w-40 rounded-md border border-line bg-paper px-2 text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => void onResolve(box, notes[box.id] || "已人工核对差异")}
                      className="text-xs text-vermilion-600 underline underline-offset-2"
                    >
                      标记已核对
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => void onVoid(box)}
                  className="text-xs text-ink-400 underline underline-offset-2"
                >
                  作废
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PrintCard({ view }: { view: ShipmentView }) {
  const api = useApi();
  const [picking, setPicking] = useState("1");
  const [delivery, setDelivery] = useState("1");
  const [labels, setLabels] = useState("1");
  const print = usePrintShipmentBundle(api, view.id);
  const [message, setMessage] = useState<string | null>(null);
  const blocked = view.printBlockedReason;
  const label =
    blocked === "NO_BOXES"
      ? "先生成箱号"
      : blocked === "DISCREPANCY" || blocked === "QUANTITY_MISMATCH"
        ? "先核对差异"
        : `一键打印（拣货单 + 箱唛×${view.boxes.length} + 发货单）`;

  return (
    <section className="rounded-lg border border-indigo-600/30 bg-indigo-50/40 px-5 py-4">
      <h2 className="text-base font-semibold">③ 一键打印</h2>
      <p className="mt-1 text-sm text-ink-400">
        同一动作重复点击不会重复出纸（幂等键 = 单据 + 版本 + 份数 + 操作人）。
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <label className="grid gap-1">
          <span className="text-ink-400">拣货单</span>
          <input
            value={picking}
            onChange={(event) => setPicking(event.target.value)}
            className="min-h-8 rounded-md border border-line bg-surface px-2"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-ink-400">箱唛 / 箱</span>
          <input
            value={labels}
            onChange={(event) => setLabels(event.target.value)}
            className="min-h-8 rounded-md border border-line bg-surface px-2"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-ink-400">发货单</span>
          <input
            value={delivery}
            onChange={(event) => setDelivery(event.target.value)}
            className="min-h-8 rounded-md border border-line bg-surface px-2"
          />
        </label>
      </div>
      <Button
        variant="primary"
        className="mt-3 w-full"
        disabled={blocked !== null || print.isPending}
        onClick={() =>
          void (async () => {
            setMessage(null);
            try {
              const result = await print.mutateAsync({
                pickingListCopies: Number(picking) || 0,
                deliveryNoteCopies: Number(delivery) || 0,
                boxLabelCopies: Number(labels) || 0,
              });
              setMessage(
                result.deduplicated.length > 0
                  ? `已在队列：${result.jobs.length} 个任务（${result.deduplicated.length} 个重复点击已去重）`
                  : `已入队 ${result.jobs.length} 个任务，代理在线会自动打印。`,
              );
            } catch (cause) {
              setMessage(cause instanceof Error ? cause.message : "打印失败");
            }
          })()
        }
      >
        {print.isPending ? "正在入队…" : label}
      </Button>
      {blocked === "DISCREPANCY" && (
        <p className="mt-2 text-xs text-vermilion-600">
          箱唛与明细不一致：先在箱子卡片上「标记已核对」。
        </p>
      )}
      {message && <p className="mt-2 text-xs text-ink-700">{message}</p>}
      <p className="mt-2 text-[11px] text-ink-400">
        共 {PrintDocumentKindLabel.PICKING_LIST} / {PrintDocumentKindLabel.BOX_LABEL} /{" "}
        {PrintDocumentKindLabel.DELIVERY_NOTE}；打印后可在顶栏「打印」看队列。
      </p>
    </section>
  );
}

function VerifyCard({
  view,
  onScan,
}: {
  view: ShipmentView;
  onScan: (boxQr: string, itemCode: string, quantity: number) => Promise<void>;
}) {
  const [boxId, setBoxId] = useState<string>("");
  const [itemCode, setItemCode] = useState("");
  const [quantity, setQuantity] = useState("1");
  const active = useMemo(
    () => view.boxes.find((box) => box.id === boxId) ?? view.boxes[0],
    [boxId, view.boxes],
  );
  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <h2 className="text-base font-semibold">④ 扫码复核</h2>
      <p className="mt-1 text-sm text-ink-400">
        扫箱唛再扫商品码：累计数量必须等于箱内应有量，否则「先核对差异」。
      </p>
      {view.boxes.length === 0 ? (
        <p className="mt-3 text-sm text-ink-400">先建箱，才能复核。</p>
      ) : (
        <div className="mt-3 grid gap-2">
          <select
            value={active?.id ?? ""}
            onChange={(event) => setBoxId(event.target.value)}
            className="min-h-9 rounded-md border border-line bg-paper px-2 text-sm"
          >
            {view.boxes.map((box) => (
              <option key={box.id} value={box.id}>
                {box.boxNo} · {box.quantity} 件
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <input
              value={itemCode}
              onChange={(event) => setItemCode(event.target.value)}
              placeholder="商品 / 样品码"
              className="min-h-9 flex-1 rounded-md border border-line bg-paper px-2 text-sm"
            />
            <input
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              inputMode="decimal"
              className="min-h-9 w-20 rounded-md border border-line bg-paper px-2 text-sm"
            />
            <Button
              disabled={!active || itemCode.trim().length === 0}
              onClick={() =>
                active && void onScan(active.qr, itemCode.trim(), Number(quantity) || 1)
              }
            >
              复核
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function ShipCard({ view }: { view: ShipmentView }) {
  const api = useApi();
  const ship = useShipShipment(api, view.id);
  const [message, setMessage] = useState<string | null>(null);
  const blocked = view.printBlockedReason;
  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <h2 className="text-base font-semibold">⑤ 确认发货</h2>
      <p className="mt-1 text-sm text-ink-400">
        箱唛与明细一致后才能确认；确认后订单推进到 SHIPPED。
      </p>
      <Button
        className="mt-3 w-full"
        disabled={blocked !== null || ship.isPending || view.status === "SHIPPED"}
        onClick={() =>
          void (async () => {
            setMessage(null);
            try {
              await ship.mutateAsync();
              setMessage("已确认发货。");
            } catch (cause) {
              setMessage(cause instanceof Error ? cause.message : "确认发货失败");
            }
          })()
        }
      >
        {view.status === "SHIPPED" ? "已发货" : ship.isPending ? "确认中…" : "确认发货"}
      </Button>
      {message && <p className="mt-2 text-xs text-ink-700">{message}</p>}
    </section>
  );
}

function ScansCard({ view }: { view: ShipmentView }) {
  if (view.scans.length === 0) return null;
  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <h2 className="text-base font-semibold">扫码流水</h2>
      <ul className="mt-2 grid gap-1">
        {view.scans.slice(0, 12).map((scan) => (
          <li
            key={scan.id}
            className="flex items-center justify-between gap-3 border-b border-line/60 py-1 text-sm"
          >
            <span>
              <Badge tone={scan.result === "OK" ? "success" : "danger"}>
                {scan.type === "PICK" ? "拣货" : "复核"}
              </Badge>
              <span className="ml-2 text-ink-700">{scan.message ?? scan.result}</span>
            </span>
            <span className="text-xs text-ink-400">
              {scan.scannedBy} · {relativeTime(scan.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
