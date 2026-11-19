import { Image, Input, Text, Textarea, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ApiError } from "@weave-order/core";
import type { FabricSample, QuoteDraft, Unit } from "@weave-order/schema";
import {
  Amount,
  Badge,
  Button,
  Card,
  Field,
  Loading,
  NavBar,
  Page,
  Sheet,
} from "../../components/ui";
import { useCanApproveQuote, useCustomers } from "../../lib/hooks";
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
import { copyText, readClipboardText, shareText } from "../../lib/clipboard";
import { openCamera } from "../../lib/nav";
import { useVoiceNote } from "../../lib/recorder";
import {
  entryParamsFromRoute,
  INITIAL_QUOTE_STATE,
  missingForDraft,
  primaryAction,
  transition,
} from "../../domain/quote/quote-flow";

/**
 * 报价页 = 一条链的四屏：输入原话 → 候选面料 → 草稿 → 已批准（原地分享）。
 *
 * 业务判断（能不能生成、能不能批、下一步是什么）都在 `domain/quote/quote-flow.ts`；
 * 这里只渲染 phase 并把点击翻译成事件，避免再出现「今日 / 审批 / 报价」三份批准逻辑。
 */

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

type Slot = "customer" | "composition" | "weight" | "quantity";

const CLIPBOARD_MESSAGE: Record<string, string> = {
  empty: "剪贴板是空的：先在微信里复制客户原话，再点这里",
  denied: "浏览器没给剪贴板权限：长按输入框手势粘贴即可",
  unsupported: "当前浏览器不支持读剪贴板：请手动粘贴到输入框",
};

export default function QuotePage() {
  const router = useRouter();
  const [state, dispatch] = useReducer(transition, INITIAL_QUOTE_STATE);
  const canApprove = useCanApproveQuote();
  const customers = useCustomers(100);
  const voice = useVoiceNote();

  const [customerSheet, setCustomerSheet] = useState(false);
  const [customerFilter, setCustomerFilter] = useState("");
  const [editSlot, setEditSlot] = useState<Slot | null>(null);
  const [slotDraft, setSlotDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<QuoteNotice | null>(null);
  const [parsed, setParsed] = useState<ParsedSlots | null>(null);
  const [preset, setPreset] = useState<FabricSample | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);

  const entered = useRef(false);

  // 入口只在首次渲染时解析一次，后续 state 由事件驱动。
  useEffect(() => {
    if (entered.current) return;
    entered.current = true;
    const params = entryParamsFromRoute(router.params);
    dispatch({ type: "enter", params });
  }, [router.params]);

  const customer = useMemo(
    () => (customers.data ?? []).find((entry) => entry.id === state.customerId) ?? null,
    [customers.data, state.customerId],
  );

  useEffect(() => {
    if (!customer) return;
    void Taro.setNavigationBarTitle({ title: `报价 · ${customer.name}` });
  }, [customer]);

  // 最近 5 个客户 + 全量搜索：打开选择器先看到最可能的那几个。
  const recentCustomers = useMemo(() => (customers.data ?? []).slice(0, 5), [customers.data]);
  const filteredCustomers = useMemo(() => {
    const list = customers.data ?? [];
    const trimmed = customerFilter.trim();
    if (!trimmed) return recentCustomers;
    return list.filter(
      (entry) =>
        entry.name.includes(trimmed) || entry.code.toLowerCase().includes(trimmed.toLowerCase()),
    );
  }, [customers.data, customerFilter, recentCustomers]);

  // 改价入口：加载既有草稿，直接落在草稿屏。
  useEffect(() => {
    if (!state.quoteId || state.draft) return;
    let cancelled = false;
    setBusy(true);
    void api
      .getQuote(state.quoteId)
      .then((detail) => {
        if (cancelled) return;
        dispatch({ type: "draftLoaded", detail });
        setSuggestions(
          Object.fromEntries(
            detail.draft.items.map((item) => [item.fabricSampleId, item.unitPrice.amount]),
          ),
        );
      })
      .catch((caught: unknown) => {
        if (!cancelled) setNotice(requestNotice(caught, "报价加载失败"));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state.quoteId, state.draft]);

  // 样品 / 相机入口：带入面料，直接进候选（用户只需要确认）。
  useEffect(() => {
    if (!state.sampleId || preset || state.mode === "edit") return;
    let cancelled = false;
    void api
      .listSamples(100)
      .then((samples) => {
        if (cancelled) return;
        const sample = samples.find((entry) => entry.id === state.sampleId);
        if (!sample) return;
        setPreset(sample);
        dispatch({ type: "samplePreset" });
      })
      .catch(() => {
        // 带入失败不影响手工粘贴流程。
      });
    return () => {
      cancelled = true;
    };
  }, [state.sampleId, state.mode, preset]);

  // 语音转写：用户停止后把文字放进原话框，不覆盖他已经输入的内容。
  useEffect(() => {
    if (!voice.transcript) return;
    dispatch({ type: "rawChanged", raw: voice.transcript });
  }, [voice.transcript]);

  const candidateSamples = useMemo(() => {
    const list = [preset, ...state.matches.map((match) => match.sample)].filter(
      (sample): sample is FabricSample => Boolean(sample),
    );
    const seen = new Set<string>();
    return list.filter((sample) => {
      if (seen.has(sample.id)) return false;
      seen.add(sample.id);
      return true;
    });
  }, [preset, state.matches]);

  // 候选卡上的「建议单价」：只给前 3 张算，避免一次打 8 个内核请求。
  useEffect(() => {
    if (state.phase !== "candidates" || !state.customerId) return;
    const quantity = Number(state.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const targets = candidateSamples
      .filter((sample) => suggestions[sample.id] === undefined)
      .slice(0, 3);
    if (targets.length === 0) return;
    let cancelled = false;
    void Promise.all(
      targets.map(async (sample) => {
        try {
          const result = await api.suggestLinePrice({
            customerId: state.customerId as string,
            fabricSampleId: sample.id,
            quantity: { value: quantity, unit: state.unit },
            currency: "CNY",
          });
          if (!result.ok) return null;
          return [sample.id, result.data.pricing.suggestedUnitPrice.amount] as const;
        } catch {
          return null;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      const found = pairs.filter((pair): pair is readonly [string, number] => pair !== null);
      if (found.length > 0) {
        setSuggestions((current) => ({
          ...current,
          ...Object.fromEntries(found),
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.customerId, state.quantity, state.unit, candidateSamples, suggestions]);

  const describeNotice = (caught: unknown, fallback: string): void => {
    if (caught instanceof ApiError) {
      setNotice(requestNotice(caught, fallback));
      return;
    }
    setNotice({ title: fallback, detail: "网络不稳，稍后重试；已填内容不会丢。" });
  };

  /** 解析原话 + 找样。自动带上已选客户，避免「有客户名还提示缺客户」。 */
  const runSearch = useCallback(
    async (rawOverride?: string) => {
      const rawText = (rawOverride ?? state.raw).trim();
      if (!rawText) {
        setNotice({ title: "还没有原话", detail: "粘贴客户微信原话，或点语音说一句。" });
        return;
      }
      if (rawOverride !== undefined) dispatch({ type: "rawChanged", raw: rawOverride });
      dispatch({ type: "parseStarted" });
      setNotice(null);
      setBusy(true);
      const slots = parseCustomerText(rawText, customers.data ?? [], {
        ...(state.customerId ? { selectedCustomerId: state.customerId } : {}),
      });
      setParsed(slots);
      if (slots.customerId && !state.customerId) {
        dispatch({ type: "customerSelected", customerId: slots.customerId });
      }
      const query =
        [state.composition, state.weight]
          .map((part) => part.trim())
          .filter(Boolean)
          .join(" ") || slots.query;
      try {
        const result = await api.searchBySpec({ query, limit: 8 });
        if (!result.ok) {
          dispatch({ type: "parseFailed", error: quoteToolNotice(result.error).title });
          return;
        }
        dispatch({
          type: "parseSucceeded",
          matches: result.data.matches,
          composition: slots.composition,
          weight: slots.weight,
          deliveryHint: slots.deliveryHint,
          quantity: slots.quantity,
        });
        if (result.data.matches.length === 0) {
          setNotice({
            title: "没有匹配的面料",
            detail: "换个说法（成分 / 克重 / 编号），或点「拍布找样」用图片找。",
          });
        }
      } catch (caught) {
        describeNotice(caught, "找样失败");
        dispatch({ type: "parseFailed", error: "找样失败，请重试" });
      } finally {
        setBusy(false);
      }
    },
    [state.raw, state.customerId, state.composition, state.weight, customers.data],
  );

  const fillFromClipboard = async () => {
    const result = await readClipboardText();
    if (!result.ok) {
      await Taro.showToast({
        title: CLIPBOARD_MESSAGE[result.reason] ?? "读取剪贴板失败",
        icon: "none",
      });
      return;
    }
    // 填入后直接解析：少一次点击，也少一次「以为没反应」。
    await runSearch(result.text);
  };

  const readUnitPrice = (): number | null => {
    const cents = yuanInputToCents(state.unitPrice);
    if (cents === null || cents <= 0) return null;
    return cents;
  };

  /** 点候选卡 → 价格（用户填的 > 建议价）→ 草稿。不要求「先选择再下一步」。 */
  const chooseCandidate = async (sample: FabricSample) => {
    const blocked = missingForDraft(state);
    if (blocked) {
      setNotice({ title: "先补一项", detail: blocked });
      if (!state.customerId) setCustomerSheet(true);
      return;
    }
    let cents = readUnitPrice();
    if (cents === null) {
      let suggested = suggestions[sample.id];
      if (suggested === undefined) {
        setBusy(true);
        try {
          const result = await api.suggestLinePrice({
            customerId: state.customerId as string,
            fabricSampleId: sample.id,
            quantity: { value: Number(state.quantity), unit: state.unit },
            currency: "CNY",
          });
          if (result.ok) suggested = result.data.pricing.suggestedUnitPrice.amount;
        } catch {
          // 建议价失败下面统一提示。
        } finally {
          setBusy(false);
        }
      }
      if (suggested === undefined) {
        setNotice({
          title: "需要单价才能出草稿",
          detail: "内核会拦截低于成本底线的报价。请在候选区填写单价后重试。",
        });
        return;
      }
      cents = suggested;
      dispatch({ type: "unitPriceChanged", unitPrice: centsToYuanInput(cents) });
    }
    await generate(sample, cents);
  };

  const generate = async (sample: FabricSample, unitPriceCents: number) => {
    if (!state.customerId) return;
    const payload = {
      customerId: state.customerId,
      items: [
        {
          fabricSampleId: sample.id,
          quantity: { value: Number(state.quantity), unit: state.unit },
          unitPrice: { amount: unitPriceCents, currency: "CNY" as const },
          ...(state.deliveryHint ? { notes: `交期：${state.deliveryHint}` } : {}),
        },
      ],
      currency: "CNY" as const,
      validityDays: 14,
      ...(state.raw ? { remarks: state.raw.slice(0, 2000) } : {}),
    };
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.generateQuoteDraft(payload);
      if (!result.ok) {
        setNotice(quoteToolNotice(result.error, { unitLabel: UNIT_LABEL[sample.unit] }));
        return;
      }
      dispatch({
        type: "draftCreated",
        draft: result.data.draft,
        unitPrice: centsToYuanInput(unitPriceCents),
      });
    } catch (caught) {
      if (caught instanceof ApiError) {
        setNotice(requestNotice(caught, "生成草稿失败"));
        return;
      }
      await enqueueOperation(offlineQueue, {
        kind: "quote.compose",
        opId: `compose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        payload,
      });
      dispatch({
        type: "offlineQueued",
        note: "已存本地：联网后自动生成草稿，并出现在有审批权同事的待办里。",
      });
    } finally {
      setBusy(false);
    }
  };

  /** 改价：走 revision 审计，不直接改草稿版本。 */
  const submitPrice = async (sampleId: string) => {
    const draft = state.draft;
    if (!draft) return;
    const line = draft.items.find((item) => item.fabricSampleId === sampleId);
    if (!line) return;
    const amount = yuanInputToCents(state.unitPrice);
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
      baseVersion: state.version,
    };
    setBusy(true);
    setNotice(null);
    const before = line.unitPrice.amount;
    try {
      const revision = await api.createRevision(revisionPayload);
      await api.decideRevision({
        revisionRequestId: revision.id,
        decision: "APPROVE",
        note: "移动端本人改价",
      });
      const detail = await api.getQuote(draft.id);
      dispatch({
        type: "repriceApplied",
        draft: detail.draft,
        version: detail.version,
        note: `${formatUnitPrice(before)} → ${formatUnitPrice(amount)} · v${detail.version}（已写审计）`,
      });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        await Taro.showModal({
          title: "报价已在其他端更新",
          content: "服务端版本已变化，已重新拉取最新版本，请确认后重新改价。",
          showCancel: false,
        });
        try {
          const detail = await api.getQuote(draft.id);
          dispatch({
            type: "draftLoaded",
            detail,
          });
        } catch {
          // 拉取失败保留原页面，用户可重试。
        }
      } else if (caught instanceof ApiError) {
        setNotice(requestNotice(caught, "改价没有提交成功"));
      } else {
        await enqueueOperation(offlineQueue, {
          kind: "quote.revise",
          opId: `revise-${draft.id}-${Date.now()}`,
          baseVersion: state.version,
          payload: revisionPayload,
        });
        dispatch({
          type: "offlineQueued",
          note: "改价已存本地：联网后按时间序提交，冲突会让你选择保留哪一版。",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const generateShare = async (quoteId: string) => {
    try {
      const result = await api.createQuoteShare({
        quoteId,
        expiresInDays: 14,
        requirePhoneTail: true,
        allowPdf: true,
      });
      dispatch({ type: "shareReady", url: result.url });
      const copied = await copyText(result.url);
      await Taro.showToast({
        title: copied ? "链接已复制，转发即可" : "链接已生成，请点复制",
        icon: copied ? "success" : "none",
      });
    } catch (caught) {
      dispatch({
        type: "shareFailed",
        error:
          caught instanceof ApiError
            ? requestNotice(caught, "分享链接没有生成").title
            : "分享链接需要联网生成，可稍后重试",
      });
    }
  };

  const approve = async () => {
    const draft = state.draft;
    if (!draft) return;
    dispatch({ type: "approveStarted" });
    setBusy(true);
    setNotice(null);
    try {
      const verified = await verifyLargeAmount(
        draft.total.amount,
        prefs.getLargeApprovalThresholdCents(),
      );
      if (!verified.verified) {
        dispatch({ type: "approvalFailed", error: "二次验证未通过，本次没有提交。" });
        await Taro.showModal({
          title: "需要二次验证",
          content: verified.message ?? "未通过验证，本次未提交。",
          showCancel: false,
        });
        return;
      }
      const result = await api.decideApproval({ id: draft.id, kind: "quote", decision: "APPROVE" });
      if (!result.ok) {
        dispatch({ type: "approvalFailed", error: quoteToolNotice(result.error).title });
        return;
      }
      dispatch({ type: "approved" });
      // 原地生成链接并复制：不再弹第二个全屏分享 Sheet。
      await generateShare(draft.id);
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.status === 409) {
          dispatch({ type: "approvalFailed", error: "已被其他端处理，请返回审批队列刷新。" });
        } else {
          dispatch({
            type: "approvalFailed",
            error: requestNotice(caught, "批准没有提交成功").title,
          });
        }
      } else {
        await enqueueOperation(offlineQueue, {
          kind: "quote.decide",
          opId: `decide-${draft.id}-${Date.now()}`,
          payload: { id: draft.id, kind: "quote", decision: "APPROVE" },
        });
        dispatch({
          type: "approvalQueued",
          note: "批准已存本地：联网后自动提交，不会重复批准。",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  /** 无审批权：草稿生成即进审批队列，提交不需要额外写操作。 */
  const submitForApproval = async () => {
    setSubmitted(true);
    await Taro.showModal({
      title: "已提交审批",
      content: "草稿已在审批队列里，有审批权的同事会在待办中看到它。",
      showCancel: false,
    });
  };

  const action = primaryAction(state, { canApprove });

  const openSlotEditor = (slot: Slot) => {
    if (slot === "customer") {
      setCustomerSheet(true);
      return;
    }
    setSlotDraft(
      slot === "composition"
        ? state.composition
        : slot === "weight"
          ? state.weight
          : slot === "quantity"
            ? state.quantity
            : "",
    );
    setEditSlot(slot);
  };

  const commitSlot = () => {
    if (editSlot === "composition" || editSlot === "weight") {
      const value = slotDraft.trim();
      // 成分 / 克重影响检索词，改完重新找样才生效。
      if (editSlot === "composition")
        dispatch({ type: "parseSucceeded", matches: state.matches, composition: value });
      else dispatch({ type: "parseSucceeded", matches: state.matches, weight: value });
    } else if (editSlot === "quantity") {
      dispatch({ type: "quantityChanged", quantity: slotDraft.trim() });
    }
    setEditSlot(null);
  };

  const resetAll = () => {
    dispatch({ type: "reset" });
    setParsed(null);
    setPreset(null);
    setNotice(null);
    setSuggestions({});
    setSubmitted(false);
    voice.reset();
  };

  const title =
    state.phase === "input" ? "快速报价" : state.phase === "candidates" ? "选面料" : "报价草稿";

  const subtitle =
    state.phase === "input"
      ? "粘贴客户原话，系统先告诉你「听懂了什么」。"
      : state.phase === "candidates"
        ? "点一张面料就出草稿，不用再点「下一步」。"
        : "草稿一屏放全：客户、面料、数量、单价、有效期。";

  return (
    <Page>
      <NavBar title={title} />
      <View className="page-sub">{subtitle}</View>

      {state.offlineQueued && state.offlineNote && (
        <View className="offline-banner">
          <Text className="offline-dot" />
          <Text>{state.offlineNote}</Text>
        </View>
      )}

      {(notice || state.error) && (
        <View className="error-banner">
          <View className="error-banner-title">{notice?.title ?? state.error}</View>
          {notice?.detail && <View className="error-banner-detail">{notice.detail}</View>}
          <View
            className="error-banner-action"
            onClick={() => {
              setNotice(null);
              dispatch({ type: "errorDismissed" });
            }}
          >
            知道了
          </View>
        </View>
      )}

      {state.phase === "input" && (
        <View>
          <Card>
            <View className="label" style={{ marginTop: 0 }}>
              客户原话（微信 / 语音）
            </View>
            <Textarea
              className="textarea"
              value={state.raw}
              maxlength={2000}
              placeholder="例如：这款 220g 棉的，要 500 米，什么价？"
              onInput={(event) => dispatch({ type: "rawChanged", raw: event.detail.value })}
            />
            <View className="actions">
              <Button variant="soft" onClick={() => void fillFromClipboard()}>
                从剪贴板填入
              </Button>
              <Button
                variant={voice.recording ? "danger" : "ghost"}
                loading={voice.recording && voice.seconds === 0}
                onClick={() => (voice.recording ? voice.stop() : void voice.start())}
              >
                {voice.recording ? `停止 · ${voice.seconds}s` : "语音说一句"}
              </Button>
            </View>
            {voice.error && <View className="field-error">{voice.error}（可直接用文字输入）</View>}
            {voice.transcript && <View className="footnote">转写：{voice.transcript}</View>}

            <View className="tag-row">
              {EXAMPLES.map((example) => (
                <View
                  key={example}
                  className="badge"
                  onClick={() => dispatch({ type: "rawChanged", raw: example })}
                >
                  {example.slice(0, 14)}…
                </View>
              ))}
            </View>

            <View className="list-row" onClick={() => setCustomerSheet(true)}>
              <View>
                <View className="list-title">{customer?.name ?? "客户：未选"}</View>
                <View className="list-sub">
                  {customer
                    ? `${customer.code} · ${customer.tier}`
                    : "不会自动用第一个客户，请选择"}
                </View>
              </View>
              <Text className="link">选择</Text>
            </View>

            <View className="actions">
              {state.mode === "camera" && (
                <Button variant="ghost" onClick={() => openCamera("find")}>
                  拍布找样
                </Button>
              )}
              <Button onClick={() => void runSearch()} loading={busy}>
                解析并找样
              </Button>
            </View>
          </Card>

          {parsed && (
            <Card className="card-flat">
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
                  交期：{parsed.deliveryHint}（写进备注，不当作承诺）
                </View>
              )}
            </Card>
          )}
        </View>
      )}

      {(state.phase === "candidates" || state.phase === "parsing") && (
        <View>
          <Card className="card-draft">
            <View className="row">
              <View className="list-title">听懂了，错了点一下改</View>
              <Badge tone={state.customerId ? "accent" : "warn"}>
                {state.customerId ? "客户已选" : "客户未选"}
              </Badge>
            </View>
            <View className="tag-row">
              <Text className="badge badge-accent" onClick={() => openSlotEditor("customer")}>
                客户：{customer?.name ?? "未选"}
              </Text>
              <Text className="badge" onClick={() => openSlotEditor("composition")}>
                成分：{state.composition || "未提"}
              </Text>
              <Text className="badge" onClick={() => openSlotEditor("weight")}>
                克重：{state.weight || "未提"}
              </Text>
              <Text className="badge" onClick={() => openSlotEditor("quantity")}>
                数量：{state.quantity}
              </Text>
              <Text className="badge" onClick={() => dispatch({ type: "unitToggled" })}>
                单位：{UNIT_LABEL[state.unit]}（点击切换）
              </Text>
            </View>

            {editSlot && editSlot !== "customer" && (
              <View className="stack" style={{ marginTop: 16 }}>
                <Input
                  className="input"
                  type={editSlot === "quantity" ? "digit" : "text"}
                  value={slotDraft}
                  focus
                  onInput={(event) => setSlotDraft(event.detail.value)}
                />
                <View className="actions">
                  <Button small variant="ghost" onClick={() => setEditSlot(null)}>
                    取消
                  </Button>
                  <Button small onClick={commitSlot}>
                    确定
                  </Button>
                </View>
              </View>
            )}

            {!customer && (
              <Button block small variant="soft" onClick={() => setCustomerSheet(true)}>
                先选客户（草稿必须归属一个客户）
              </Button>
            )}
          </Card>

          {busy && candidateSamples.length === 0 && <View className="loading">正在找面料…</View>}

          {!busy && candidateSamples.length === 0 && (
            <Card className="card-flat">
              <View className="muted">
                {state.emptyReason === "INDEXING"
                  ? "还有样品在索引，稍后重试。"
                  : "确实没有匹配：换一种说法（成分 / 克重 / 编号），或拍一张布样。"}
              </View>
              <View className="actions">
                <Button variant="ghost" onClick={() => dispatch({ type: "back" })}>
                  改原话
                </Button>
                <Button variant="soft" onClick={() => openCamera("find")}>
                  拍布找样
                </Button>
              </View>
            </Card>
          )}

          {candidateSamples.length > 0 && (
            <View className="candidate-strip">
              {candidateSamples.map((sample) => {
                const match = state.matches.find((entry) => entry.sample.id === sample.id);
                const suggested = suggestions[sample.id];
                const unitMismatch = sample.unit !== state.unit;
                return (
                  <Card
                    key={sample.id}
                    className="candidate-card"
                    onClick={unitMismatch ? undefined : () => void chooseCandidate(sample)}
                  >
                    {sample.primaryImageUrl ? (
                      <Image
                        className="candidate-thumb"
                        src={sample.primaryImageUrl}
                        mode="aspectFill"
                      />
                    ) : (
                      <View className="candidate-thumb candidate-thumb-empty">待补图</View>
                    )}
                    <View className="list-title">{sample.name}</View>
                    <View className="list-sub">
                      {match ? `相似度 ${(match.score * 100).toFixed(0)}%` : "带入的样品"}
                      {sample.composition ? ` · ${sample.composition}` : ""}
                    </View>
                    <View className="tag-row">
                      {(match?.matchedOn ?? []).map((field) => (
                        <Badge key={field} tone="accent">
                          {MATCH_LABEL[field] ?? field}
                        </Badge>
                      ))}
                      {unitMismatch ? (
                        <Badge tone="warn">按{UNIT_LABEL[sample.unit]}计价</Badge>
                      ) : (
                        <Badge tone={suggested === undefined ? "info" : "accent"}>
                          {suggested === undefined
                            ? "建议价计算中"
                            : `建议 ${formatUnitPrice(suggested)}/${UNIT_LABEL[sample.unit]}`}
                        </Badge>
                      )}
                    </View>
                    {unitMismatch ? (
                      <View className="footnote">
                        当前按{UNIT_LABEL[state.unit]}下单，点上方「单位」切到
                        {UNIT_LABEL[sample.unit]}再用。
                      </View>
                    ) : (
                      <View className="candidate-cta">点这张 → 出草稿</View>
                    )}
                  </Card>
                );
              })}
            </View>
          )}

          <Card className="card-flat">
            <View className="label">数量与单价</View>
            <View className="row" style={{ marginTop: 0 }}>
              <Input
                className="input"
                type="digit"
                value={state.quantity}
                style={{ flex: 1, minWidth: 0 }}
                onInput={(event) =>
                  dispatch({ type: "quantityChanged", quantity: event.detail.value })
                }
              />
              <Text className="badge" onClick={() => dispatch({ type: "unitToggled" })}>
                {UNIT_LABEL[state.unit]}
              </Text>
            </View>
            <View className="row">
              <Input
                className="input"
                type="digit"
                value={state.unitPrice}
                placeholder="留空则用建议单价"
                style={{ flex: 1, minWidth: 0 }}
                onInput={(event) =>
                  dispatch({ type: "unitPriceChanged", unitPrice: event.detail.value })
                }
              />
            </View>
            <View className="footnote">
              单价留空时点候选卡会直接用「建议单价」；内核会拦低于成本底线的报价。
            </View>
            <View className="actions">
              <Button variant="ghost" onClick={() => dispatch({ type: "back" })}>
                改原话
              </Button>
              <Button variant="ghost" onClick={resetAll}>
                重来
              </Button>
            </View>
          </Card>
        </View>
      )}

      {!state.draft && (state.phase === "draft" || state.phase === "approving") && (
        <Loading label="正在加载报价…" />
      )}

      {state.draft &&
        (state.phase === "draft" ||
          state.phase === "approving" ||
          state.phase === "approved" ||
          state.phase === "sharing") && (
          <View>
            <DraftCard state={state} customerName={customer?.name ?? "客户"} />

            {state.revisionNote && (
              <Card className="card-flat">
                <View className="muted">{state.revisionNote}</View>
              </Card>
            )}

            {state.phase === "draft" && (
              <Card>
                <View className="label">改价（写审计，不覆盖历史）</View>
                <View className="row" style={{ marginTop: 0 }}>
                  <Input
                    className="input"
                    type="digit"
                    value={state.unitPrice}
                    style={{ flex: 1, minWidth: 0 }}
                    onInput={(event) =>
                      dispatch({ type: "unitPriceChanged", unitPrice: event.detail.value })
                    }
                  />
                  <Button
                    small
                    variant="soft"
                    loading={busy}
                    onClick={() => {
                      const sampleId = state.draft?.items[0]?.fabricSampleId;
                      if (sampleId) void submitPrice(sampleId);
                    }}
                  >
                    改价
                  </Button>
                </View>
                <View className="actions">
                  <Button variant="ghost" onClick={resetAll}>
                    重来
                  </Button>
                  <Button
                    loading={busy}
                    onClick={() => {
                      if (action.kind === "submit") void submitForApproval();
                      else void approve();
                    }}
                  >
                    {action.label}
                  </Button>
                </View>
                <View className="footnote">{action.hint}</View>
                {submitted && (
                  <View className="footnote">已提交：草稿在审批队列里，等待有审批权的同事。</View>
                )}
              </Card>
            )}

            {(state.phase === "approving" ||
              state.phase === "approved" ||
              state.phase === "sharing") && (
              <Card>
                {state.phase === "approving" && <View className="loading">正在批准…</View>}
                {state.phase === "approved" && (
                  <View>
                    <View className="list-title">已批准 · 正在生成客户链接</View>
                    <View className="list-sub">{action.hint}</View>
                    {state.shareError && (
                      <View className="actions">
                        <Button
                          onClick={() => {
                            if (state.draft) void generateShare(state.draft.id);
                          }}
                        >
                          重新生成链接
                        </Button>
                      </View>
                    )}
                  </View>
                )}
                {state.phase === "sharing" && state.shareUrl && (
                  <View>
                    <View className="list-title">链接已生成 · 直接转发</View>
                    <View className="share-box">{state.shareUrl}</View>
                    <View className="actions">
                      <Button
                        variant="ghost"
                        onClick={() =>
                          void copyText(state.shareUrl as string).then((copied) =>
                            Taro.showToast({
                              title: copied ? "已复制" : "复制失败，请长按选择",
                              icon: "none",
                            }),
                          )
                        }
                      >
                        复制链接
                      </Button>
                      <Button
                        onClick={() =>
                          void shareText(state.shareUrl as string, "织序报价").then((shared) =>
                            Taro.showToast({
                              title: shared ? "已转发" : "复制失败，请长按选择",
                              icon: "none",
                            }),
                          )
                        }
                      >
                        转发
                      </Button>
                    </View>
                    <View className="footnote">有效期 14 天 · 客户需验证手机尾号。</View>
                  </View>
                )}
                <View className="actions">
                  <Button variant="ghost" onClick={resetAll}>
                    再报一单
                  </Button>
                </View>
                <View className="footnote">
                  接受 ≠ 合同：客户接受只产生成交意向，转订单仍需人工确认。
                </View>
              </Card>
            )}

            <View className="footnote">
              客户看到的是只读快照，不含成本 / 毛利 / 内部备注；token 明文只在生成时出现一次。
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
        {!customerFilter.trim() && <View className="label">最近 5 个</View>}
        {filteredCustomers.map((entry) => (
          <View
            key={entry.id}
            className="list-row"
            onClick={() => {
              dispatch({ type: "customerSelected", customerId: entry.id });
              setCustomerSheet(false);
            }}
          >
            <View>
              <View className="list-title">{entry.name}</View>
              <View className="list-sub">
                {entry.code} · {entry.tier}
              </View>
            </View>
            {entry.id === state.customerId && <Badge tone="accent">已选</Badge>}
          </View>
        ))}
        {filteredCustomers.length === 0 && <View className="muted">没有匹配的客户</View>}
      </Sheet>
    </Page>
  );
}

/** 草稿一屏：客户、面料、数量、单价、有效期、毛利、交期缺什么。 */
function DraftCard({
  state,
  customerName,
}: {
  state: ReturnType<typeof transition>;
  customerName: string;
}) {
  const draft = state.draft as QuoteDraft;
  const requirement = draft.approvalRequirement;
  const first = draft.items[0];
  const unitLabel = first ? UNIT_LABEL[first.quantity.unit] : UNIT_LABEL[state.unit];
  return (
    <Card className="card-draft">
      <View className="row">
        <View>
          <View className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
            <Badge tone={state.status === "DRAFT" ? "warn" : "accent"}>
              {state.status === "DRAFT" ? "草稿" : "已批准"}
            </Badge>
            <Text className="tiny">v{state.version}</Text>
          </View>
          <View className="list-title" style={{ marginTop: 8 }}>
            {customerName}
          </View>
        </View>
        <Amount size="lg">{formatMoneyShort(draft.total.amount, draft.currency)}</Amount>
      </View>

      <Field label="面料" value={first?.description ?? "未选"} />
      <Field
        label="数量"
        value={first ? `${first.quantity.value} ${UNIT_LABEL[first.quantity.unit]}` : "—"}
      />
      <Field
        label="单价"
        value={first ? `${formatUnitPrice(first.unitPrice.amount)} / ${unitLabel}` : "—"}
        hint="改价走 revision，新价格在批准后生效"
      />
      <Field
        label="有效期"
        value={`${draft.validityDays} 天 · 到 ${new Date(draft.expiresAt).toLocaleDateString("zh-CN")}`}
      />
      <Field label="毛利" value="内核按成本核算（不向手机暴露成本明细）" />
      <Field
        label="交期"
        value={state.deliveryHint ?? "原话里没提"}
        hint={state.deliveryHint ? "写进备注，不当作承诺" : "批准前请向客户确认交期"}
      />
      {requirement && (
        <Field
          label="审批要求"
          value={
            requirement.escalated
              ? `需 ${requirement.role} 复核（${requirement.reasons.length} 条风险）`
              : "本人可直接批准"
          }
        />
      )}
    </Card>
  );
}
