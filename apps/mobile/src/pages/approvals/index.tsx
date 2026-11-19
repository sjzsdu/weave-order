import { Input, Text, Textarea, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, queryKeys } from "@weave-order/core";
import type { ApprovalItem } from "@weave-order/schema";
import {
  Amount,
  Badge,
  Button,
  Card,
  EmptyState,
  Loading,
  OfflineBanner,
  Page,
  SectionTitle,
  Sheet,
  Stat,
} from "../../components/ui";
import { SwipeCard } from "../../components/SwipeCard";
import { useApprovalQueue, useOfflineBanner } from "../../lib/hooks";
import { formatMoneyShort, relativeTime } from "../../lib/format";
import { verifyLargeAmount } from "../../lib/biometric";
import { useVoiceNote } from "../../lib/recorder";
import { api, offlineQueue, prefs } from "../../lib/runtime";
import { enqueueOperation } from "../../lib/offline";
import { copyText } from "../../lib/clipboard";
import { openCustomer, openQuote } from "../../lib/nav";

interface UndoState {
  item: ApprovalItem;
  decision: "APPROVE" | "REJECT";
  note?: string;
}

const REJECT_REASONS = ["价格高了", "交期不行", "规格不对", "客户改需求", "其他"];

export default function ApprovalsPage() {
  const queryClient = useQueryClient();
  const { isLoading, refetch, items, hasMore, isFetchingNextPage, fetchNextPage } =
    useApprovalQueue();
  const banner = useOfflineBanner();

  const [undo, setUndo] = useState<UndoState | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<ApprovalItem | null>(null);
  const [reason, setReason] = useState(REJECT_REASONS[0] ?? "其他");
  const [note, setNote] = useState("");
  const [shareFor, setShareFor] = useState<ApprovalItem | null>(null);
  const [shareDays, setShareDays] = useState("14");
  const [sharePhoneTail, setSharePhoneTail] = useState(true);
  const [sharePdf, setSharePdf] = useState(true);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareExpires, setShareExpires] = useState<string | null>(null);
  const voice = useVoiceNote();

  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdown = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timeout.current) clearTimeout(timeout.current);
      if (countdown.current) clearInterval(countdown.current);
    };
  }, []);

  useEffect(() => {
    if (voice.transcript) {
      setNote((current) =>
        current.includes(voice.transcript) ? current : `${current} ${voice.transcript}`.trim(),
      );
    }
  }, [voice.transcript]);

  const removeFromCache = (id: string) => {
    queryClient.setQueryData(
      queryKeys.approvalQueue(30),
      (current: { pages: { items: ApprovalItem[] }[] } | undefined) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                items: page.items.filter((item) => item.id !== id),
              })),
            }
          : current,
    );
  };

  const commit = async (state: UndoState) => {
    setBusy(true);
    try {
      if (state.decision === "APPROVE" && state.item.amountCents !== null) {
        const verified = await verifyLargeAmount(
          state.item.amountCents,
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
      }
      const result = await api.decideApproval({
        id: state.item.id,
        kind: state.item.kind,
        decision: state.decision,
        ...(state.note ? { note: state.note.slice(0, 500) } : {}),
      });
      if (!result.ok) {
        await Taro.showToast({ title: result.error.message, icon: "none" });
        await refetch();
        return;
      }
      removeFromCache(state.item.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.panorama });
      if (state.decision === "APPROVE" && state.item.kind === "quote") {
        setShareFor(state.item);
        setShareUrl(null);
        setShareExpires(null);
      } else {
        await Taro.showToast({
          title: state.decision === "APPROVE" ? "已批准" : "已驳回",
          icon: "success",
        });
      }
    } catch (error) {
      if (!(error instanceof ApiError)) {
        await enqueueOperation(offlineQueue, {
          kind: "quote.decide",
          opId: `decide-${state.item.id}-${Date.now()}`,
          payload: {
            id: state.item.id,
            kind: state.item.kind,
            decision: state.decision,
            ...(state.note ? { note: state.note.slice(0, 500) } : {}),
          },
        });
        removeFromCache(state.item.id);
        await Taro.showToast({ title: "已存本地，联网后提交", icon: "none" });
      } else if (error.status === 409) {
        await Taro.showModal({
          title: "已被其他端处理",
          content: "服务端版本已变化，已刷新队列；请确认后再操作。",
          showCancel: false,
        });
        await refetch();
      } else {
        await Taro.showToast({ title: error.message, icon: "none" });
      }
    } finally {
      setBusy(false);
      setUndo(null);
      if (countdown.current) clearInterval(countdown.current);
    }
  };

  const schedule = (item: ApprovalItem, decision: "APPROVE" | "REJECT", decisionNote?: string) => {
    setUndo({ item, decision, note: decisionNote });
    setSecondsLeft(5);
    if (timeout.current) clearTimeout(timeout.current);
    if (countdown.current) clearInterval(countdown.current);
    countdown.current = setInterval(() => setSecondsLeft((value) => Math.max(0, value - 1)), 1000);
    timeout.current = setTimeout(() => {
      void commit({ item, decision, note: decisionNote });
    }, 5000);
  };

  const cancelUndo = () => {
    if (timeout.current) clearTimeout(timeout.current);
    if (countdown.current) clearInterval(countdown.current);
    setUndo(null);
    setSecondsLeft(0);
  };

  const confirmReject = () => {
    if (!rejecting) return;
    const fullNote = `${reason}${note.trim() ? `：${note.trim()}` : ""}`;
    setRejecting(null);
    setNote("");
    voice.reset();
    schedule(rejecting, "REJECT", fullNote);
  };

  const createShare = async () => {
    if (!shareFor) return;
    setBusy(true);
    try {
      const days = Number(shareDays);
      const result = await api.createQuoteShare({
        quoteId: shareFor.id,
        expiresInDays: Number.isFinite(days) && days > 0 ? Math.min(90, Math.round(days)) : 14,
        requirePhoneTail: sharePhoneTail,
        allowPdf: sharePdf,
      });
      setShareUrl(result.url);
      setShareExpires(result.share.expiresAt);
      const copied = await copyText(result.url);
      await Taro.showToast({
        title: copied ? "链接已复制" : "链接已生成，请手动复制",
        icon: copied ? "success" : "none",
      });
    } catch (error) {
      if (error instanceof ApiError) {
        await Taro.showToast({ title: error.message, icon: "none" });
      } else {
        await Taro.showToast({ title: "分享链接需要联网生成", icon: "none" });
      }
    } finally {
      setBusy(false);
    }
  };

  const nativeShare = async () => {
    if (!shareUrl) return;
    const nav =
      typeof navigator === "undefined"
        ? undefined
        : (navigator as Navigator & {
            share?: (data: { title: string; url: string }) => Promise<void>;
          });
    if (nav && nav.share) {
      try {
        await nav.share({ title: "织序报价", url: shareUrl });
      } catch {
        // 用户取消分享不提示错误。
      }
    } else {
      await Taro.showToast({ title: "已复制，去微信粘贴", icon: "none" });
    }
  };

  const totalAmount = items.reduce((sum, item) => sum + (item.amountCents ?? 0), 0);
  const quoteCount = items.filter((item) => item.kind === "quote").length;

  return (
    <Page>
      <View className="page-title">审批</View>
      <View className="page-sub">大卡片、拇指区；左滑驳回、右滑通过，5 秒内可撤销。</View>

      {banner.show && <OfflineBanner text={banner.text} />}

      <Card>
        <View className="stats">
          <Stat label="待处理" value={items.length} tone={items.length > 0 ? "warn" : "accent"} />
          <Stat label="报价单" value={quoteCount} />
          <Stat label="金额" value={formatMoneyShort(totalAmount)} />
        </View>
        <View className="footnote">金额与成本校验全部在服务端完成；前端只提交「批 / 驳回」。</View>
      </Card>

      <SectionTitle title="待你决定" hint="草稿用虚线，批准后生效" />

      {isLoading && items.length === 0 ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState title="没有待批的事" desc="小织在跟客户；有新的草稿会出现在这里。" />
      ) : (
        <View>
          {items.map((item) => (
            <SwipeCard
              key={item.id}
              disabled={busy}
              onApprove={() => schedule(item, "APPROVE")}
              onReject={() => {
                setRejecting(item);
                setNote("");
                setReason(REJECT_REASONS[0] ?? "其他");
              }}
            >
              <Card className="card-draft">
                <View className="row">
                  <View>
                    <View className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
                      <Badge tone="warn">{item.kind === "quote" ? "报价草稿" : "寄样草稿"}</Badge>
                      {typeof item.version === "number" && <Badge>v{item.version}</Badge>}
                      <Text className="tiny">{relativeTime(item.createdAt)}</Text>
                    </View>
                    <View className="list-title" style={{ marginTop: 8 }}>
                      {item.title}
                    </View>
                  </View>
                  {item.amountCents !== null && (
                    <Amount size="lg">
                      {formatMoneyShort(item.amountCents, item.currency ?? "CNY")}
                    </Amount>
                  )}
                </View>

                <View className="muted" style={{ marginTop: 10 }}>
                  {item.summary}
                </View>

                <View className="section-head" style={{ margin: "16px 0 8px" }}>
                  <View className="tiny">依据和缺什么都在摘要里；点下面看客户详情</View>
                  <Text className="link" onClick={() => openCustomer(item.customerId)}>
                    客户 360
                  </Text>
                </View>

                <View className="actions">
                  <Button
                    variant="danger"
                    small
                    onClick={() => {
                      setRejecting(item);
                      setNote("");
                      setReason(REJECT_REASONS[0] ?? "其他");
                    }}
                  >
                    驳回
                  </Button>
                  {item.kind === "quote" && (
                    <Button
                      variant="ghost"
                      small
                      onClick={() => openQuote({ mode: "edit", quoteId: item.id })}
                    >
                      改价
                    </Button>
                  )}
                  <Button small onClick={() => schedule(item, "APPROVE")}>
                    批准
                  </Button>
                </View>
              </Card>
            </SwipeCard>
          ))}
          {hasMore && (
            <Button
              block
              variant="ghost"
              loading={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              加载更多（已显示 {items.length} 条）
            </Button>
          )}
        </View>
      )}

      {undo && (
        <View className="undo-bar">
          <Text>
            {undo.decision === "APPROVE" ? "已批准" : "已驳回"} · {undo.item.title} · {secondsLeft}s
            后提交
          </Text>
          <Text className="undo-action" onClick={cancelUndo}>
            撤销
          </Text>
        </View>
      )}

      <Sheet
        open={Boolean(rejecting)}
        title="驳回与分诊"
        onClose={() => {
          setRejecting(null);
          voice.reset();
        }}
        footer={
          <Button block variant="danger" onClick={confirmReject}>
            确认驳回
          </Button>
        }
      >
        {rejecting && <View className="muted">{rejecting.title}</View>}
        <View className="label">原因（仅内部记录）</View>
        <View className="wrap">
          {REJECT_REASONS.map((entry) => (
            <View
              key={entry}
              className={`badge ${reason === entry ? "badge-danger" : ""}`}
              onClick={() => setReason(entry)}
            >
              {entry}
            </View>
          ))}
        </View>

        <View className="label">语音批注</View>
        {voice.recording ? (
          <View className="recording" onClick={() => voice.stop()}>
            <View className="pulse" />
            <Text>正在录音 {voice.seconds}s · 点一下停止</Text>
          </View>
        ) : (
          <Button variant="soft" block onClick={() => void voice.start()}>
            {voice.audioPath ? "重新录音" : "长按说话（点按开始）"}
          </Button>
        )}
        {voice.error && <View className="footnote">{voice.error}</View>}
        {voice.audioPath && (
          <View className="footnote">录音已保留（转写由服务端 ASR 接入；可先文字补充）。</View>
        )}
        {voice.transcript && <View className="footnote">转写：{voice.transcript}</View>}

        <View className="label">补充说明</View>
        <Textarea
          className="textarea"
          value={note}
          maxlength={500}
          placeholder="例如：老客户，15.00 可以做，但要 7 天内发货"
          onInput={(event) => setNote(event.detail.value)}
        />
      </Sheet>

      <Sheet
        open={Boolean(shareFor)}
        title="报价已批准 · 分享给客户"
        onClose={() => {
          setShareFor(null);
          setShareUrl(null);
        }}
        footer={
          shareUrl ? (
            <View className="actions" style={{ marginTop: 0 }}>
              <Button variant="ghost" onClick={() => void nativeShare()}>
                转发
              </Button>
              <Button onClick={() => void createShare()} loading={busy}>
                再生成一条
              </Button>
            </View>
          ) : (
            <Button block onClick={() => void createShare()} loading={busy}>
              生成分享链接
            </Button>
          )
        }
      >
        {shareFor && (
          <View>
            <View className="list-title">{shareFor.title}</View>
            <View className="list-sub">
              {shareFor.summary} ·{" "}
              {formatMoneyShort(shareFor.amountCents ?? 0, shareFor.currency ?? "CNY")}
            </View>
          </View>
        )}

        <View className="label">有效期（天）</View>
        <Input
          className="input"
          type="number"
          value={shareDays}
          onInput={(event) => setShareDays(event.detail.value)}
        />

        <View className="list-row" onClick={() => setSharePhoneTail((value) => !value)}>
          <View>
            <View className="list-title">手机尾号验证</View>
            <View className="list-sub">默认开启；客户无需注册</View>
          </View>
          <Badge tone={sharePhoneTail ? "accent" : "neutral"}>{sharePhoneTail ? "开" : "关"}</Badge>
        </View>
        <View className="list-row" onClick={() => setSharePdf((value) => !value)}>
          <View>
            <View className="list-title">允许下载 PDF</View>
            <View className="list-sub">水印到客户名 + 报价编号</View>
          </View>
          <Badge tone={sharePdf ? "accent" : "neutral"}>{sharePdf ? "开" : "关"}</Badge>
        </View>

        {shareUrl && (
          <View style={{ marginTop: 16 }}>
            <View className="label">客户链接（已复制）</View>
            <View className="share-box">{shareUrl}</View>
            {shareExpires && (
              <View className="footnote">
                到期时间 {new Date(shareExpires).toLocaleDateString("zh-CN")} · 仅已批准报价可分享 ·
                接受 ≠ 合同
              </View>
            )}
          </View>
        )}
        {!shareUrl && <View className="footnote">客户链接需要联网生成，离线时不会保存。</View>}
      </Sheet>

      <View className="footnote">
        大额审批在你的阈值以上会要求二次验证：App 端 Face ID，小程序微信生物识别，H5 明确二次确认。
        阈值可在「更多」里调整。
      </View>
    </Page>
  );
}
