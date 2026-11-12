import { Input, Text, Textarea, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "@weave-order/core";
import type { FabricSample, QuoteDraft, QuoteStatus, SpecMatch, Unit } from "@weave-order/schema";
import { Amount, Badge, Button, Card, Page, Sheet } from "../../components/ui";
import { useCustomers } from "../../lib/hooks";
import {
  centsToYuanInput,
  parseCustomerText,
  yuanInputToCents,
} from "../../lib/parse-customer-text";
import type { ParsedSlots } from "../../lib/parse-customer-text";
import { formatMoneyShort, formatUnitPrice } from "../../lib/format";
import { verifyLargeAmount } from "../../lib/biometric";
import { api, offlineQueue, prefs } from "../../lib/runtime";
import { enqueueOperation } from "../../lib/offline";
import { copyText } from "../../lib/clipboard";

type Step = "input" | "candidates" | "draft";

const UNIT_LABEL: Record<Unit, string> = {
  meter: "米",
  kilogram: "公斤",
  yard: "码",
  piece: "件",
};

const MATCH_LABEL: Record<string, string> = {
  code: "编号一致",
  name: "品名一致",
  composition: "成分一致",
  weight: "克重一致",
};

const EXAMPLES = [
  "这款 220g 棉的，要 500 米，什么价？",
  "青禾要 300 米 涤棉 180g，15 块能做吗",
  "上次那块亚麻，再来 200 码，尽快",
];

export default function QuotePage() {
  const router = useRouter();
  const quoteId = router.params.quoteId ?? "";
  const paramCustomerId = router.params.customerId ?? "";
  const paramSampleId = router.params.sampleId ?? "";

  const customers = useCustomers(100);
  const [step, setStep] = useState<Step>("input");
  const [raw, setRaw] = useState("");
  const [parsed, setParsed] = useState<ParsedSlots | null>(null);
  const [customerId, setCustomerId] = useState(paramCustomerId);
  const [quantity, setQuantity] = useState("500");
  const [unit, setUnit] = useState<Unit>("meter");
  const [matches, setMatches] = useState<SpecMatch[]>([]);
  const [preset, setPreset] = useState<FabricSample | null>(null);
  const [draft, setDraft] = useState<QuoteDraft | null>(null);
  const [status, setStatus] = useState<QuoteStatus>("DRAFT");
  const [version, setVersion] = useState(1);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [revisionNote, setRevisionNote] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [customerSheet, setCustomerSheet] = useState(false);
  const [customerFilter, setCustomerFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customer = useMemo(
    () => (customers.data ?? []).find((entry) => entry.id === customerId) ?? null,
    [customers.data, customerId],
  );

  const filteredCustomers = useMemo(() => {
    const list = customers.data ?? [];
    const trimmed = customerFilter.trim();
    if (!trimmed) return list;
    return list.filter(
      (entry) =>
        entry.name.includes(trimmed) || entry.code.toLowerCase().includes(trimmed.toLowerCase()),
    );
  }, [customers.data, customerFilter]);

  useEffect(() => {
    if (!customerId && customers.data?.[0]) setCustomerId(customers.data[0].id);
  }, [customerId, customers.data]);

  useEffect(() => {
    if (!customer) return;
    void Taro.setNavigationBarTitle({ title: `报价 · ${customer.name}` });
  }, [customer]);

  // 从审批卡 / 客户 360 进来：直接加载草稿，进入改价 / 批准。
  useEffect(() => {
    if (!quoteId) return;
    let cancelled = false;
    const load = async () => {
      setBusy(true);
      try {
        const detail = await api.getQuote(quoteId);
        if (cancelled) return;
        setDraft(detail.draft);
        setStatus(detail.status);
        setVersion(detail.version);
        setCustomerId(detail.draft.customerId);
        setPrices(
          Object.fromEntries(
            detail.draft.items.map((item) => [
              item.fabricSampleId,
              centsToYuanInput(item.unitPrice.amount),
            ]),
          ),
        );
        setStep("draft");
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "报价加载失败");
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [quoteId]);

  // 从相机找样进来：带入样品，补数量即可生成草稿。
  useEffect(() => {
    if (!paramSampleId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const samples = await api.listSamples(100);
        const sample = samples.find((entry) => entry.id === paramSampleId);
        if (cancelled || !sample) return;
        setPreset(sample);
        setStep("candidates");
      } catch {
        // 相机带入失败不影响手工粘贴流程。
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [paramSampleId]);

  const doParse = () => {
    const result = parseCustomerText(raw, customers.data ?? []);
    setParsed(result);
    if (result.customerId) setCustomerId(result.customerId);
    if (result.quantity) {
      setQuantity(String(result.quantity.value));
      setUnit(result.quantity.unit);
    }
    return result;
  };

  const findSamples = async () => {
    setError(null);
    const slots = doParse();
    setBusy(true);
    try {
      const result = await api.searchBySpec({ query: slots.query, limit: 8 });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setMatches(result.data.matches);
      if (result.data.matches.length === 0) {
        setError("没有匹配的面料。换个说法（成分 / 克重 / 编号），或去相机拍照找样。");
      }
      setStep("candidates");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "找样失败");
    } finally {
      setBusy(false);
    }
  };

  const generate = async (sample: FabricSample) => {
    if (!customerId) {
      setCustomerSheet(true);
      await Taro.showToast({ title: "先选客户", icon: "none" });
      return;
    }
    const quantityValue = Number(quantity);
    if (!Number.isFinite(quantityValue) || quantityValue <= 0) {
      await Taro.showToast({ title: "数量要大于 0", icon: "none" });
      return;
    }
    setBusy(true);
    setError(null);
    const payload = {
      customerId,
      items: [
        {
          fabricSampleId: sample.id,
          quantity: { value: quantityValue, unit },
          unitPrice: { amount: parsed?.targetPriceCents ?? 0, currency: "CNY" as const },
          ...(parsed?.deliveryHint ? { notes: `交期：${parsed.deliveryHint}` } : {}),
        },
      ],
      currency: "CNY" as const,
      validityDays: 14,
      ...(raw ? { remarks: raw.slice(0, 2000) } : {}),
    };
    try {
      const result = await api.generateQuoteDraft(payload);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const next = result.data.draft;
      setDraft(next);
      setStatus("DRAFT");
      setVersion(1);
      setPrices(
        Object.fromEntries(
          next.items.map((item) => [item.fabricSampleId, centsToYuanInput(item.unitPrice.amount)]),
        ),
      );
      setStep("draft");
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        await enqueueOperation(offlineQueue, {
          kind: "quote.compose",
          opId: `compose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          payload,
        });
        await Taro.showModal({
          title: "已存本地",
          content: "原话与槽位已入离线队列，联网后自动生成草稿，并出现在审批里。",
          showCancel: false,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const applyLocalPrice = (sampleId: string, amount: number) => {
    setDraft((current) => {
      if (!current) return current;
      const items = current.items.map((item) =>
        item.fabricSampleId === sampleId
          ? {
              ...item,
              unitPrice: { amount, currency: current.currency },
              lineTotal: {
                amount: Math.round(amount * item.quantity.value),
                currency: current.currency,
              },
            }
          : item,
      );
      const total = items.reduce((sum, item) => sum + item.lineTotal.amount, 0);
      return {
        ...current,
        items,
        subtotal: { amount: total, currency: current.currency },
        total: { amount: total, currency: current.currency },
      };
    });
    setVersion((current) => current + 1);
  };

  const submitPrice = async (sampleId: string) => {
    if (!draft) return;
    const input = prices[sampleId] ?? "";
    const amount = yuanInputToCents(input);
    const line = draft.items.find((item) => item.fabricSampleId === sampleId);
    if (!line) return;
    if (amount === null || amount <= 0) {
      await Taro.showToast({ title: "单价格式不对（最多两位小数）", icon: "none" });
      return;
    }
    if (amount === line.unitPrice.amount) {
      await Taro.showToast({ title: "单价没有变化", icon: "none" });
      return;
    }
    const revisionPayload = {
      entityType: "quote" as const,
      entityId: draft.id,
      source: "INLINE" as const,
      instruction: `移动端改价 ${formatUnitPrice(line.unitPrice.amount)} → ${formatUnitPrice(amount)}`,
      patch: {
        items: [{ fabricSampleId: sampleId, unitPrice: { amount, currency: draft.currency } }],
      },
      baseVersion: version,
    };
    setBusy(true);
    setError(null);
    try {
      const revision = await api.createRevision(revisionPayload);
      await api.decideRevision({
        revisionRequestId: revision.id,
        decision: "APPROVE",
        note: "移动端本人改价",
      });
      const detail = await api.getQuote(draft.id);
      const before = line.unitPrice.amount;
      setDraft(detail.draft);
      setVersion(detail.version);
      setPrices(
        Object.fromEntries(
          detail.draft.items.map((item) => [
            item.fabricSampleId,
            centsToYuanInput(item.unitPrice.amount),
          ]),
        ),
      );
      setRevisionNote(
        `${formatUnitPrice(before)} → ${formatUnitPrice(amount)} · v${detail.version}（已写审计）`,
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        await Taro.showModal({
          title: "报价已在其他端更新",
          content: "服务端版本已变化。已重新拉取最新版本，请确认后重新改价。",
          showCancel: false,
        });
        try {
          const detail = await api.getQuote(draft.id);
          setDraft(detail.draft);
          setVersion(detail.version);
          setPrices(
            Object.fromEntries(
              detail.draft.items.map((item) => [
                item.fabricSampleId,
                centsToYuanInput(item.unitPrice.amount),
              ]),
            ),
          );
        } catch {
          // 拉取失败保留原页面，用户可重试。
        }
      } else if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        await enqueueOperation(offlineQueue, {
          kind: "quote.revise",
          opId: `revise-${draft.id}-${Date.now()}`,
          baseVersion: version,
          payload: revisionPayload,
        });
        applyLocalPrice(sampleId, amount);
        setRevisionNote("已存本地：联网后按时间序提交；冲突会让你选择保留哪一版");
        await Taro.showToast({ title: "已存本地，联网后提交", icon: "none" });
      }
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const verified = await verifyLargeAmount(
        draft.total.amount,
        prefs.getLargeApprovalThresholdCents(),
      );
      if (!verified.verified) {
        await Taro.showModal({
          title: "需要二次验证",
          content: verified.message ?? "未通过验证，本次未提交。",
          showCancel: false,
        });
        return;
      }
      const result = await api.decideApproval({ id: draft.id, kind: "quote", decision: "APPROVE" });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setStatus("SENT");
      await Taro.showToast({ title: "已批准，可分享链接", icon: "success" });
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.status === 409) {
          await Taro.showModal({
            title: "已被其他端处理",
            content: "服务端版本已变化，请返回审批队列刷新。",
            showCancel: false,
          });
        } else {
          setError(caught.message);
        }
      } else {
        await enqueueOperation(offlineQueue, {
          kind: "quote.decide",
          opId: `decide-${draft.id}-${Date.now()}`,
          payload: { id: draft.id, kind: "quote", decision: "APPROVE" },
        });
        await Taro.showToast({ title: "已存本地，联网后提交", icon: "none" });
      }
    } finally {
      setBusy(false);
    }
  };

  const createShare = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const result = await api.createQuoteShare({
        quoteId: draft.id,
        expiresInDays: 14,
        requirePhoneTail: true,
        allowPdf: true,
      });
      setShareUrl(result.url);
      const copied = await copyText(result.url);
      await Taro.showToast({
        title: copied ? "链接已复制" : "链接已生成，请手动复制",
        icon: copied ? "success" : "none",
      });
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught.message);
      else await Taro.showToast({ title: "分享链接需要联网生成", icon: "none" });
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStep("input");
    setDraft(null);
    setStatus("DRAFT");
    setMatches([]);
    setPreset(null);
    setParsed(null);
    setRevisionNote(null);
    setShareUrl(null);
    setError(null);
  };

  const candidateList = preset
    ? [{ sample: preset, score: 1, matchedOn: [] as SpecMatch["matchedOn"] }, ...matches]
    : matches;

  return (
    <Page>
      <View className="page-title">{step === "draft" ? "报价草稿" : "快速报价"}</View>
      <View className="page-sub">
        {step === "draft"
          ? "改价 = 原地改 + 版本 + diff；批准后经内核 confirm 才生效。"
          : "粘贴客户原话，系统先给「听懂了什么」，错了可改。"}
      </View>

      {error && (
        <Card className="card-flat">
          <View style={{ color: "#b26a00", fontSize: 24 }}>{error}</View>
        </Card>
      )}

      {step === "input" && (
        <View>
          <Card>
            <View className="label" style={{ marginTop: 0 }}>
              客户原话（微信 / 语音转写）
            </View>
            <Textarea
              className="textarea"
              value={raw}
              maxlength={2000}
              placeholder="例如：这款 220g 棉的，要 500 米，什么价？"
              onInput={(event) => setRaw(event.detail.value)}
            />
            <View className="tag-row">
              {EXAMPLES.map((example) => (
                <View key={example} className="badge" onClick={() => setRaw(example)}>
                  {example.slice(0, 14)}…
                </View>
              ))}
            </View>

            <View className="list-row" onClick={() => setCustomerSheet(true)}>
              <View>
                <View className="list-title">{customer?.name ?? "选择客户"}</View>
                <View className="list-sub">
                  {customer ? `${customer.code} · ${customer.tier}` : "报价必须归属一个客户"}
                </View>
              </View>
              <Text className="link">切换</Text>
            </View>

            <View className="actions">
              <Button variant="ghost" onClick={() => setParsed(doParse())}>
                解析原话
              </Button>
              <Button onClick={() => void findSamples()} loading={busy}>
                找样
              </Button>
            </View>
          </Card>

          {parsed && (
            <Card className="card-draft">
              <View className="row">
                <View className="list-title">系统听懂了什么</View>
                <Badge
                  tone={
                    parsed.confidence === "high"
                      ? "accent"
                      : parsed.confidence === "medium"
                        ? "warn"
                        : "danger"
                  }
                >
                  {parsed.confidence === "high"
                    ? "槽位齐全"
                    : parsed.confidence === "medium"
                      ? "还缺信息"
                      : "信息很少"}
                </Badge>
              </View>
              <View className="tag-row">
                {parsed.hits.map((hit) => (
                  <Badge key={hit} tone="accent">
                    {hit}
                  </Badge>
                ))}
                {parsed.missing.map((miss) => (
                  <Badge key={miss} tone="warn">
                    缺：{miss}
                  </Badge>
                ))}
              </View>
              {parsed.deliveryHint && (
                <View className="footnote">
                  交期：{parsed.deliveryHint}（会写进报价备注，不当作承诺）
                </View>
              )}

              <View className="label">数量</View>
              <View className="row">
                <Input
                  className="input"
                  type="digit"
                  value={quantity}
                  onInput={(event) => setQuantity(event.detail.value)}
                />
                <View
                  className="badge"
                  onClick={() => setUnit(unit === "meter" ? "yard" : "meter")}
                >
                  {UNIT_LABEL[unit]}
                </View>
              </View>

              <View className="label">检索词（可改）</View>
              <View className="muted">{parsed.query}</View>
            </Card>
          )}
        </View>
      )}

      {step === "candidates" && (
        <View>
          <Card className="card-flat">
            <View className="row">
              <View>
                <View className="list-title">
                  {customer?.name ?? "未选客户"} · {quantity} {UNIT_LABEL[unit]}
                </View>
                <View className="list-sub">候选来自 T-002；每条都带命中理由</View>
              </View>
              <Text className="link" onClick={() => setStep("input")}>
                改原话
              </Text>
            </View>
          </Card>

          {candidateList.length === 0 ? (
            <Card className="card-flat">
              <View className="muted">没有候选。回上一步换检索词，或去相机拍照找样。</View>
            </Card>
          ) : (
            candidateList.map((match) => (
              <Card key={match.sample.id}>
                <View className="row">
                  <View>
                    <View className="list-title">{match.sample.name}</View>
                    <View className="list-sub">
                      {match.sample.code} · {match.sample.composition ?? "成分未填"} ·{" "}
                      {match.sample.weight ?? ""}
                    </View>
                    <View className="tag-row">
                      {match.matchedOn.length > 0 ? (
                        match.matchedOn.map((field) => (
                          <Badge key={field} tone="accent">
                            {MATCH_LABEL[field] ?? field}
                          </Badge>
                        ))
                      ) : (
                        <Badge tone="info">相机带入</Badge>
                      )}
                    </View>
                  </View>
                  <Badge tone="accent">{(match.score * 100).toFixed(0)}</Badge>
                </View>
                <View className="actions">
                  <Button block small onClick={() => void generate(match.sample)} loading={busy}>
                    用这个面料生成草稿
                  </Button>
                </View>
              </Card>
            ))
          )}
        </View>
      )}

      {step === "draft" && draft && (
        <View>
          <Card className="card-draft">
            <View className="row">
              <View>
                <View className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
                  <Badge tone={draft.status === "DRAFT" ? "warn" : "accent"}>
                    {draft.status === "DRAFT" ? "草稿" : draft.status}
                  </Badge>
                  <Text className="tiny">v{version} · 金额由内核计算</Text>
                </View>
                <View className="list-title" style={{ marginTop: 8 }}>
                  {customer?.name ?? "客户"} · {draft.items.length} 行
                </View>
              </View>
              <Amount size="lg">{formatMoneyShort(draft.total.amount, draft.currency)}</Amount>
            </View>
            <View className="footnote">
              有效期 {draft.validityDays} 天 · 到期{" "}
              {new Date(draft.expiresAt).toLocaleDateString("zh-CN")}
            </View>
          </Card>

          {draft.items.map((item) => (
            <Card key={item.fabricSampleId}>
              <View className="row">
                <View>
                  <View className="list-title">{item.description}</View>
                  <View className="list-sub">
                    {item.quantity.value} {UNIT_LABEL[item.quantity.unit]} · 小计{" "}
                    {formatMoneyShort(item.lineTotal.amount, draft.currency)}
                  </View>
                </View>
              </View>
              <View className="row" style={{ marginTop: 16 }}>
                <View className="field-label">单价（元 / {UNIT_LABEL[item.quantity.unit]}）</View>
                <Input
                  className="input input-inline"
                  type="digit"
                  value={prices[item.fabricSampleId] ?? ""}
                  onInput={(event) =>
                    setPrices((current) => ({
                      ...current,
                      [item.fabricSampleId]: event.detail.value,
                    }))
                  }
                />
                <Button
                  small
                  variant="soft"
                  loading={busy}
                  onClick={() => void submitPrice(item.fabricSampleId)}
                >
                  改价
                </Button>
              </View>
            </Card>
          ))}

          {revisionNote && (
            <Card className="card-flat">
              <View className="muted">{revisionNote}</View>
            </Card>
          )}

          <Card>
            {status === "DRAFT" ? (
              <View>
                <View className="need-row">
                  <View className="list-title">批准后才会生效</View>
                  <View className="list-sub">
                    改幅超过 10% 或金额超阈值会升级审批；本单会记录二次验证结果。
                  </View>
                </View>
                <View className="actions">
                  <Button variant="ghost" onClick={reset}>
                    重来
                  </Button>
                  <Button onClick={() => void approve()} loading={busy}>
                    批准报价
                  </Button>
                </View>
              </View>
            ) : (
              <View>
                <View className="list-title">已批准 · 生成客户链接</View>
                <View className="list-sub">只有已批准的报价能分享；链接指向当前版本快照。</View>
                {shareUrl ? (
                  <View style={{ marginTop: 12 }}>
                    <View className="share-box">{shareUrl}</View>
                    <View className="actions">
                      <Button
                        variant="ghost"
                        onClick={() =>
                          void copyText(shareUrl).then((copied) =>
                            Taro.showToast({
                              title: copied ? "已复制" : "复制失败，请手动选择",
                              icon: "none",
                            }),
                          )
                        }
                      >
                        复制链接
                      </Button>
                      <Button onClick={() => void createShare()} loading={busy}>
                        再生成一条
                      </Button>
                    </View>
                  </View>
                ) : (
                  <View className="actions">
                    <Button block onClick={() => void createShare()} loading={busy}>
                      生成分享链接（有效期 14 天 · 尾号验证）
                    </Button>
                  </View>
                )}
                <View className="footnote">
                  接受 ≠ 合同：客户接受只产生成交意向，转订单仍需人工确认。
                </View>
              </View>
            )}
          </Card>

          <View className="footnote">
            客户看到的是只读快照，绝不包含成本 / 毛利 / 内部备注；token 明文只在生成时出现一次。
          </View>
        </View>
      )}

      <Sheet open={customerSheet} title="选择客户" onClose={() => setCustomerSheet(false)}>
        <Input
          className="input"
          value={customerFilter}
          placeholder="搜客户名 / 编号"
          onInput={(event) => setCustomerFilter(event.detail.value)}
        />
        {filteredCustomers.map((entry) => (
          <View
            key={entry.id}
            className="list-row"
            onClick={() => {
              setCustomerId(entry.id);
              setCustomerSheet(false);
            }}
          >
            <View>
              <View className="list-title">{entry.name}</View>
              <View className="list-sub">
                {entry.code} · {entry.tier}
              </View>
            </View>
            {entry.id === customerId && <Badge tone="accent">已选</Badge>}
          </View>
        ))}
      </Sheet>
    </Page>
  );
}
