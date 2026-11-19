import { Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FabricSample, ReceivableListItem } from "@weave-order/schema";
import { Badge, Button, Card, SectionTitle, Sheet } from "./ui";
import { formatMoneyShort, shortDate } from "../lib/format";
import { api } from "../lib/runtime";
import { userFacingErrorMessage } from "../lib/upload-failure";

type SheetKind = "ship" | "collect" | null;

/**
 * 客户 360 首屏的「现在能做什么」。
 *
 * 只放手机上真能走完的动作：快速报价、登记寄样、登记回款。
 * `can*` 由服务端能力清单决定，按钮隐藏只是体验优化，真正的拦截在服务端。
 * 两张表单都刻意做成最低限度：选一条记录 + 填一个数字，不复制 PC 的全表单。
 */
export function CustomerNowActions({
  customerId,
  customerName,
  canQuote,
  canShip,
  canCollect,
  onQuote,
}: {
  customerId: string;
  customerName: string;
  canQuote: boolean;
  canShip: boolean;
  canCollect: boolean;
  onQuote: () => void;
}) {
  const queryClient = useQueryClient();
  const [sheet, setSheet] = useState<SheetKind>(null);

  return (
    <>
      <SectionTitle title="现在能做什么" hint="先动手，再看数字与时间线" />
      <Card>
        {canQuote && (
          <Button block onClick={onQuote}>
            快速报价给 {customerName}
          </Button>
        )}
        <View className="actions">
          {canShip && (
            <Button small variant="ghost" onClick={() => setSheet("ship")}>
              登记寄样
            </Button>
          )}
          {canCollect && (
            <Button small variant="ghost" onClick={() => setSheet("collect")}>
              登记回款
            </Button>
          )}
        </View>
      </Card>

      <ShipSampleSheet
        open={sheet === "ship"}
        customerId={customerId}
        onClose={() => setSheet(null)}
        onDone={async () => {
          await queryClient.invalidateQueries();
          setSheet(null);
        }}
      />
      <CollectPaymentSheet
        open={sheet === "collect"}
        customerId={customerId}
        onClose={() => setSheet(null)}
        onDone={async () => {
          await queryClient.invalidateQueries();
          setSheet(null);
        }}
      />
    </>
  );
}

function ShipSampleSheet({
  open,
  customerId,
  onClose,
  onDone,
}: {
  open: boolean;
  customerId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [samples, setSamples] = useState<FabricSample[]>([]);
  const [selected, setSelected] = useState<FabricSample | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 关掉弹层即清空：下次打开不带着上一单的选择，避免寄错样品。
  useEffect(() => {
    if (open) return;
    setQuery("");
    setSamples([]);
    setSelected(null);
    setQuantity("1");
    setNote("");
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .listSamplesPage({ query: query.trim(), limit: 20 })
        .then((page) => {
          if (!cancelled) setSamples(page.samples);
        })
        .catch((caught: unknown) => {
          if (!cancelled) setError(userFacingErrorMessage(caught, "样品加载失败，请重试"));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query]);

  const submit = async () => {
    if (!selected) {
      setError("先选一款样品");
      return;
    }
    const value = Number(quantity);
    if (!Number.isFinite(value) || value <= 0) {
      setError("数量要大于 0");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createSampleShipment({
        customerId,
        items: [{ sampleId: selected.id, quantity: { value, unit: selected.unit } }],
        note: note.trim() ? note.trim() : null,
      });
      await Taro.showToast({ title: "寄样单已创建，待确认", icon: "none" });
      await onDone();
    } catch (caught) {
      setError(userFacingErrorMessage(caught, "寄样登记失败，请重试"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      title="登记寄样"
      onClose={onClose}
      footer={
        <Button block onClick={() => void submit()} loading={busy} disabled={!selected}>
          创建寄样单
        </Button>
      }
    >
      <View className="muted">寄样单先落草稿，确认后才会出现在「待处理」里。</View>
      <View className="label">找样品</View>
      <Input
        className="input"
        value={query}
        placeholder="搜品名 / 编号"
        onInput={(event) => setQuery(event.detail.value)}
      />
      {loading && samples.length === 0 && <View className="muted">加载中…</View>}
      {samples.map((sample) => (
        <View
          key={sample.id}
          className={`list-row${selected?.id === sample.id ? " row-active" : ""}`}
          onClick={() => setSelected(sample)}
        >
          <View>
            <View className="list-title">{sample.name}</View>
            <View className="list-sub">
              {sample.code}
              {sample.composition ? ` · ${sample.composition}` : ""}
              {sample.weight ? ` · ${sample.weight}` : ""}
            </View>
          </View>
          {selected?.id === sample.id ? (
            <Badge tone="accent">已选</Badge>
          ) : (
            <Text className="link">选择</Text>
          )}
        </View>
      ))}
      {!loading && samples.length === 0 && !error && (
        <View className="muted">没有匹配的样品。</View>
      )}
      <View className="label">数量（{selected?.unit === "piece" ? "件" : "米"}）</View>
      <Input
        className="input"
        type="digit"
        value={quantity}
        onInput={(event) => setQuantity(event.detail.value)}
      />
      <View className="label">备注（可选）</View>
      <Input
        className="input"
        value={note}
        placeholder="如：三色各一块，附成分单"
        onInput={(event) => setNote(event.detail.value)}
      />
      {error && <View className="field-error">{error}</View>}
    </Sheet>
  );
}

function CollectPaymentSheet({
  open,
  customerId,
  onClose,
  onDone,
}: {
  open: boolean;
  customerId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [items, setItems] = useState<ReceivableListItem[]>([]);
  const [selected, setSelected] = useState<ReceivableListItem | null>(null);
  const [amountYuan, setAmountYuan] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setItems([]);
      setSelected(null);
      setAmountYuan("");
      setNote("");
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .receivables({ customerId, bucket: "all", limit: 20 })
      .then((page) => {
        if (cancelled) return;
        // 已结清的不用再登记；按到期日近的在前，手机上通常只处理最近一笔。
        const open = page.receivables.filter((item) => item.balance.amount > 0);
        setItems(open);
        const first = open[0];
        if (first) {
          setSelected(first);
          setAmountYuan((first.balance.amount / 100).toFixed(2).replace(/\.00$/, ""));
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(userFacingErrorMessage(caught, "应收加载失败，请重试"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, customerId]);

  const submit = async () => {
    if (!selected) {
      setError("先选一笔应收");
      return;
    }
    const yuan = Number(amountYuan);
    if (!Number.isFinite(yuan) || yuan <= 0) {
      setError("金额要大于 0");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.recordPayment(selected.id, {
        amount: { amount: Math.round(yuan * 100), currency: selected.balance.currency },
        note: note.trim() ? note.trim() : null,
      });
      await Taro.showToast({ title: "回款已登记", icon: "success" });
      await onDone();
    } catch (caught) {
      setError(userFacingErrorMessage(caught, "回款登记失败，请重试"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      title="登记回款"
      onClose={onClose}
      footer={
        <Button block onClick={() => void submit()} loading={busy} disabled={!selected}>
          确认登记
        </Button>
      }
    >
      {loading && <View className="muted">加载应收…</View>}
      {!loading && items.length === 0 && !error && (
        <View className="muted">这位客户没有未收的应收。</View>
      )}
      {items.map((item) => (
        <View
          key={item.id}
          className={`list-row${selected?.id === item.id ? " row-active" : ""}`}
          onClick={() => {
            setSelected(item);
            setAmountYuan((item.balance.amount / 100).toFixed(2).replace(/\.00$/, ""));
          }}
        >
          <View>
            <View className="list-title">
              订单 {item.orderCode} · 未收{" "}
              {formatMoneyShort(item.balance.amount, item.balance.currency)}
            </View>
            <View className="list-sub">
              到期 {shortDate(item.dueDate)}
              {item.daysOverdue > 0 ? ` · 逾期 ${item.daysOverdue} 天` : ""}
            </View>
          </View>
          {selected?.id === item.id ? <Badge tone="accent">已选</Badge> : null}
        </View>
      ))}
      <View className="label">本次回款（元）</View>
      <Input
        className="input"
        type="digit"
        value={amountYuan}
        onInput={(event) => setAmountYuan(event.detail.value)}
      />
      <View className="label">备注（可选）</View>
      <Input
        className="input"
        value={note}
        placeholder="如：客户微信转账，尾号 6621"
        onInput={(event) => setNote(event.detail.value)}
      />
      {error && <View className="field-error">{error}</View>}
    </Sheet>
  );
}
