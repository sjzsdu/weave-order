import { Image, Input, Text, Textarea, View } from "@tarojs/components";
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
import { quoteToolNotice, requestNotice } from "../../lib/quote-notice";
import type { QuoteNotice } from "../../lib/quote-notice";
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
  /** 生成草稿前的单价（元/单位）：客户原话里提过就预填，否则由报价助手建议。 */
  const [unitPrice, setUnitPrice] = useState("");
  const [priceError, setPriceError] = useState<string | null>(null);
  const [priceHint, setPriceHint] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<QuoteNotice | null>(null);
  /** 出错时记住是哪块面料，提示里的「建议单价」可以直接作用于它。 */
  const [failedSample, setFailedSample] = useState<FabricSample | null>(null);

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
        if (!cancelled) setNotice(requestNotice(caught, "报价加载失败"));
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
    // 客户原话里提过价格就预填；没提则留空，等报价助手给合规建议价。
    if (result.targetPriceCents !== null) {
      setUnitPrice(centsToYuanInput(result.targetPriceCents));
      setPriceError(null);
    }
    return result;
  };

  const findSamples = async () => {
    setNotice(null);
    const slots = doParse();
    setBusy(true);
    try {
      const result = await api.searchBySpec({ query: slots.query, limit: 8 });
      if (!result.ok) {
        setNotice(quoteToolNotice(result.error));
        return;
      }
      setMatches(result.data.matches);
      if (result.data.matches.length === 0) {
        setNotice({
          title: "没有匹配的面料",
          detail: "换个说法（成分 / 克重 / 编号），或去相机拍照找样。",
        });
      }
      setStep("candidates");
    } catch (caught) {
      setNotice(requestNotice(caught, "找样失败"));
    } finally {
      setBusy(false);
    }
  };

  /** 把输入框里的「元」转成分；不合规时把错误标在字段上，不发请求。 */
  const readUnitPrice = (): number | null => {
    const cents = yuanInputToCents(unitPrice);
    if (cents === null || cents <= 0) {
      setPriceError(
        `请填写单价（元/${UNIT_LABEL[unit]}）。不知道报多少，可以点「建议单价」让报价助手算一个合规价。`,
      );
      setNotice(null);
      return null;
    }
    setPriceError(null);
    return cents;
  };

  /**
   * 建议单价（T-006）：成本在服务端，手机端算不出来，只能请内核给建议价。
   * 结果回填到可编辑输入框，业务员仍然可以自己改。
   */
  const suggestPrice = async (sample?: FabricSample | null) => {
    const target = sample ?? preset ?? matches[0]?.sample ?? null;
    if (!target) {
      setNotice({
        title: "先找一块面料",
        detail: "建议单价要绑定具体面料（成本不同），请先点「找样」。",
      });
      return;
    }
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
    setSuggesting(true);
    setNotice(null);
    setPriceError(null);
    try {
      const result = await api.suggestLinePrice({
        customerId,
        fabricSampleId: target.id,
        quantity: { value: quantityValue, unit },
        currency: "CNY",
      });
      if (!result.ok) {
        setNotice(quoteToolNotice(result.error, { unitLabel: UNIT_LABEL[target.unit] }));
        return;
      }
      const next = result.data.pricing;
      setUnitPrice(centsToYuanInput(next.suggestedUnitPrice.amount));
      const basis = next.components.map((component) => component.label).join(" + ");
      setPriceHint(
        `报价助手建议 ${formatUnitPrice(next.suggestedUnitPrice.amount)}/${UNIT_LABEL[target.unit]}（${basis}，内核算出，可改）`,
      );
    } catch (caught) {
      setNotice(requestNotice(caught, "报价助手暂时给不出建议价"));
    } finally {
      setSuggesting(false);
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
    const unitPriceCents = readUnitPrice();
    if (unitPriceCents === null) return;
    setBusy(true);
    setFailedSample(sample);
    setNotice(null);
    const payload = {
      customerId,
      items: [
        {
          fabricSampleId: sample.id,
          quantity: { value: quantityValue, unit },
          unitPrice: { amount: unitPriceCents, currency: "CNY" as const },
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
        setNotice(
          quoteToolNotice(result.error, {
            unitLabel: UNIT_LABEL[sample.unit],
          }),
        );
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
        setNotice(requestNotice(caught, "生成草稿失败"));
      } else {
        await enqueueOperation(offlineQueue, {
          kind: "quote.compose",
          opId: `compose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          payload,
        });
        await Taro.showModal({
          title: "已存本地",
          content: "原话、数量与单价已入离线队列，联网后自动生成草稿，并出现在审批里。",
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
    setNotice(null);
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
        setNotice(requestNotice(caught, "改价没有提交成功"));
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
    setNotice(null);
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
        setNotice(quoteToolNotice(result.error));
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
          setNotice(requestNotice(caught, "批准没有提交成功"));
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
      if (caught instanceof ApiError) setNotice(requestNotice(caught, "分享链接没有生成"));
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
    setNotice(null);
    setUnitPrice("");
    setPriceError(null);
    setPriceHint(null);
    setFailedSample(null);
  };

  const candidateList = preset
    ? [{ sample: preset, score: 1, matchedOn: [] as SpecMatch["matchedOn"] }, ...matches]
    : matches;

  const draftPriceCents = yuanInputToCents(unitPrice);
  const draftQuantityValue = Number(quantity);
  const estimatedSubtotal =
    draftPriceCents && Number.isFinite(draftQuantityValue) && draftQuantityValue > 0
      ? draftPriceCents * draftQuantityValue
      : null;

  return (
    <Page>
      <View className="page-title">{step === "draft" ? "报价草稿" : "快速报价"}</View>
      <View className="page-sub">
        {step === "draft"
          ? "改价 = 原地改 + 版本 + diff；批准后经内核 confirm 才生效。"
          : "粘贴客户原话，系统先给「听懂了什么」，错了可改。"}
      </View>

      {notice && (
        <View className="error-banner">
          <View className="error-banner-title">{notice.title}</View>
          {notice.detail && <View className="error-banner-detail">{notice.detail}</View>}
          {notice.action?.kind === "suggest-price" && (
            <View className="error-banner-action" onClick={() => void suggestPrice(failedSample)}>
              {notice.action.label} →
            </View>
          )}
        </View>
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

          {/* 单价是生成草稿的硬门槛：内核会拦低于成本底线的报价，所以先在这里让用户给价。 */}
          <Card className="card-draft">
            <View className="row">
              <View className="list-title">这一单的单价</View>
              <Badge tone={draftPriceCents ? "accent" : "warn"}>
                {draftPriceCents ? "已填写" : "还没填"}
              </Badge>
            </View>
            <View className="label">单价（元 / {UNIT_LABEL[unit]}）</View>
            <View className="row" style={{ marginTop: 0 }}>
              <Input
                className="input"
                type="digit"
                value={unitPrice}
                placeholder="如 15.00"
                style={{ flex: 1, minWidth: 0 }}
                onInput={(event) => {
                  setUnitPrice(event.detail.value);
                  setPriceError(null);
                }}
              />
              <Button small variant="soft" loading={suggesting} onClick={() => void suggestPrice()}>
                建议单价
              </Button>
            </View>
            {priceError && <View className="field-error">{priceError}</View>}
            {priceHint && <View className="footnote">{priceHint}</View>}
            {!priceHint && !priceError && (
              <View className="footnote">
                客户原话里提到价格会预填；没提就点「建议单价」，由报价助手按成本底线和默认毛利给一个合规价。
              </View>
            )}
            {estimatedSubtotal !== null && (
              <View className="footnote">
                预计小计 {formatMoneyShort(estimatedSubtotal)}（最终金额由内核重算）
              </View>
            )}
          </Card>

          {candidateList.length === 0 ? (
            <Card className="card-flat">
              <View className="muted">没有候选。回上一步换检索词，或去相机拍照找样。</View>
            </Card>
          ) : (
            candidateList.map((match) => (
              <Card key={match.sample.id}>
                <View className="row">
                  <View className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                    {match.sample.primaryImageUrl ? (
                      <Image
                        src={match.sample.primaryImageUrl}
                        mode="aspectFill"
                        style={{ width: 48, height: 48, borderRadius: 6, flexShrink: 0 }}
                      />
                    ) : (
                      <View
                        style={{
                          width: 48,
                          height: 48,
                          borderRadius: 6,
                          border: "1px dashed #d8d3c8",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 10,
                          color: "#9a9385",
                          flexShrink: 0,
                        }}
                      >
                        待补图
                      </View>
                    )}
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
                  </View>
                  <Badge tone="accent">{(match.score * 100).toFixed(0)}</Badge>
                </View>
                <View className="actions">
                  <Button
                    block
                    small
                    disabled={match.sample.unit !== unit}
                    onClick={() => void generate(match.sample)}
                    loading={busy}
                  >
                    用这个面料生成草稿
                  </Button>
                </View>
                {match.sample.unit !== unit && (
                  <View className="footnote">
                    这块面料按{UNIT_LABEL[match.sample.unit]}计价，当前数量单位是
                    {UNIT_LABEL[unit]}；请点「改原话」把单位改过来再生成。
                  </View>
                )}
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
              <View className="label">单价（元 / {UNIT_LABEL[item.quantity.unit]}）</View>
              <View className="row" style={{ marginTop: 0 }}>
                <Input
                  className="input"
                  type="digit"
                  value={prices[item.fabricSampleId] ?? ""}
                  style={{ flex: 1, minWidth: 0 }}
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
