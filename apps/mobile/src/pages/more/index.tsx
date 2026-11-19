import { Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueuedOperation } from "@weave-order/core";
import type { TenantChoice } from "@weave-order/schema";
import { Badge, Button, Card, Page, SectionTitle, Sheet } from "../../components/ui";
import { useInstallPrompt } from "../../lib/pwa";
import { useNetworkStatus, useQueueState, useSyncQueue } from "../../lib/hooks";
import { formatMoneyShort, relativeTime } from "../../lib/format";
import {
  IS_MOCK,
  api,
  loadTenantContext,
  mockControls,
  offlineQueue,
  prefs,
  TARO_ENV,
} from "../../lib/runtime";
import { onQueueChanged } from "../../lib/offline";
import { ROLES, ROLE_LABEL, isRole } from "../../lib/roles";
import type { Role } from "../../lib/roles";

const KIND_LABEL: Record<string, string> = {
  "quote.compose": "原话 → 报价草稿",
  "quote.revise": "改价（带基线版本）",
  "quote.decide": "批 / 驳回",
  "shipment.proof": "拍照回传",
};

export default function MorePage() {
  const queryClient = useQueryClient();
  const network = useNetworkStatus();
  const queue = useQueueState();
  const sync = useSyncQueue();
  const install = useInstallPrompt();
  const mock = mockControls();

  const [items, setItems] = useState<QueuedOperation[]>([]);
  const [role, setRole] = useState<Role>(() => {
    const saved = prefs.getRole();
    return isRole(saved) ? saved : "sales";
  });
  const [showQueue, setShowQueue] = useState(false);
  const [showThreshold, setShowThreshold] = useState(false);
  const [thresholdYuan, setThresholdYuan] = useState(
    (prefs.getLargeApprovalThresholdCents() / 100).toFixed(0),
  );
  const [busy, setBusy] = useState(false);
  const [simulatedOffline, setSimulatedOffline] = useState(mock?.isOffline() ?? false);
  const [company, setCompany] = useState<{
    currentName: string;
    tenants: TenantChoice[];
    pending: Record<string, number>;
  } | null>(null);

  const refresh = useCallback(async () => {
    setItems(await offlineQueue.list());
  }, []);

  const loadCompany = useCallback(async () => {
    try {
      const [me, list, pending] = await Promise.all([
        api.me(),
        api.tenants(),
        offlineQueue.pendingCounts(),
      ]);
      setCompany({
        currentName: "tenants" in me ? "" : me.tenant.name,
        tenants: list.tenants,
        pending,
      });
    } catch {
      setCompany(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadCompany();
    const off = onQueueChanged(() => void refresh());
    return off;
  }, [refresh, loadCompany]);

  /**
   * 切换公司：服务端换会话后整页数据重拉；离线队列按租户过滤，
   * 所以切过去不会把上一家的待提交条目一起交上去。
   */
  const switchCompany = async () => {
    const options = (company?.tenants ?? []).filter((entry) => entry.available);
    if (options.length < 2) return;
    try {
      const picked = await Taro.showActionSheet({
        itemList: options.map((entry) => entry.name),
      });
      const target = options[picked.tapIndex ?? -1];
      if (!target) return;
      await api.switchTenant({ tenantId: target.tenantId });
      await loadTenantContext();
      await queryClient.invalidateQueries();
      await refresh();
      await loadCompany();
      void Taro.showToast({ title: `已切换到 ${target.name}`, icon: "none" });
    } catch (error) {
      void Taro.showToast({
        title: error instanceof Error ? error.message : "切换失败",
        icon: "none",
      });
    }
  };

  const runSync = async () => {
    setBusy(true);
    try {
      const result = await sync();
      await refresh();
      await Taro.showToast({
        title: `已提交 ${result.sent} · 冲突 ${result.conflicts} · 失败 ${result.failed}`,
        icon: "none",
      });
    } finally {
      setBusy(false);
    }
  };

  const switchRole = async () => {
    try {
      const result = await Taro.showActionSheet({
        itemList: ROLES.map((entry) => ROLE_LABEL[entry]),
      });
      const picked = ROLES[result.tapIndex ?? -1];
      if (picked) {
        setRole(picked);
        prefs.setRole(picked);
        await Taro.showToast({ title: `身份已切换为${ROLE_LABEL[picked]}`, icon: "none" });
      }
    } catch {
      // 用户取消切换不处理。
    }
  };

  const saveThreshold = () => {
    const yuan = Number(thresholdYuan);
    if (!Number.isFinite(yuan) || yuan <= 0) {
      void Taro.showToast({ title: "阈值要大于 0 元", icon: "none" });
      return;
    }
    prefs.setLargeApprovalThresholdCents(Math.round(yuan * 100));
    setShowThreshold(false);
    void Taro.showToast({ title: "阈值已保存（仅本机）", icon: "success" });
  };

  const resolveConflict = async (op: QueuedOperation, choice: "local" | "server") => {
    if (choice === "server") {
      await offlineQueue.remove(op.opId);
      await Taro.showToast({ title: "已保留服务端版本", icon: "none" });
    } else {
      if (typeof op.serverVersion !== "number") {
        await Taro.showToast({ title: "缺少服务端版本，先刷新审批再重试", icon: "none" });
        return;
      }
      await offlineQueue.retryWithServerVersion(op.opId, op.serverVersion);
      await Taro.showToast({ title: "已按服务端版本重新排队", icon: "none" });
    }
    await refresh();
  };

  const drop = async (op: QueuedOperation) => {
    const result = await Taro.showModal({
      title: "丢弃这条离线操作？",
      content: `${KIND_LABEL[op.kind] ?? op.kind} · 丢弃后不会提交`,
      confirmText: "丢弃",
      confirmColor: "#b3261e",
    });
    if (!result.confirm) return;
    await offlineQueue.remove(op.opId);
    await refresh();
  };

  const toggleOffline = () => {
    if (!mock) return;
    const next = !simulatedOffline;
    mock.setOffline(next);
    setSimulatedOffline(next);
    void Taro.showToast({ title: next ? "已模拟断网" : "已恢复网络", icon: "none" });
  };

  const simulateRemoteEdit = () => {
    if (!mock) return;
    try {
      const result = mock.simulateRemoteEdit();
      void queryClient.invalidateQueries();
      void Taro.showToast({ title: `服务端已改为 v${result.version}`, icon: "none" });
    } catch (error) {
      void Taro.showToast({
        title: error instanceof Error ? error.message : "没有可模拟的草稿",
        icon: "none",
      });
    }
  };

  const resetDemo = async () => {
    if (!mock) return;
    const confirmed = await Taro.showModal({
      title: "重置演示数据？",
      content: "客户端 mock 状态与缓存会清空，重新生成示例报价。",
      confirmColor: "#b3261e",
    });
    if (!confirmed.confirm) return;
    mock.reset();
    await queryClient.invalidateQueries();
    await refresh();
    await Taro.showToast({ title: "已重置", icon: "success" });
  };

  return (
    <Page>
      <View className="page-title">我的</View>
      <View className="page-sub">身份、离线队列、安装与隐私；批量的事留在 PC。</View>

      {IS_MOCK && (
        <Card className="card-flat">
          <View className="row">
            <View>
              <View className="list-title">演示模式（Mock）</View>
              <View className="list-sub">契约端点本地实现；可模拟断网与并发冲突</View>
            </View>
            <Badge tone="info">Mock</Badge>
          </View>
          <View className="actions">
            <Button small variant="ghost" onClick={toggleOffline}>
              {simulatedOffline ? "恢复网络" : "模拟断网"}
            </Button>
            <Button small variant="ghost" onClick={simulateRemoteEdit}>
              模拟服务端改价
            </Button>
          </View>
          <View className="actions">
            <Button small variant="danger" onClick={() => void resetDemo()}>
              重置演示数据
            </Button>
          </View>
        </Card>
      )}

      {company && (
        <>
          <SectionTitle title="当前公司" hint="切换后权限与数据整体切换" />
          <Card>
            <View className="list-row" onClick={() => void switchCompany()}>
              <View>
                <View className="list-title">{company.currentName || "尚未选择公司"}</View>
                <View className="list-sub">
                  {company.tenants.filter((entry) => entry.available).length > 1
                    ? "点击切换公司"
                    : "你只属于这一家公司"}
                </View>
              </View>
              {company.tenants.filter((entry) => entry.available).length > 1 ? (
                <Text className="link">切换</Text>
              ) : (
                <Badge tone="accent">当前</Badge>
              )}
            </View>
            {Object.entries(company.pending)
              .filter(([tenantId]) => tenantId !== "unknown")
              .map(([tenantId, count]) => {
                const tenant = company.tenants.find((entry) => entry.tenantId === tenantId);
                if (!tenant) return null;
                return (
                  <View key={tenantId} className="list-row">
                    <View>
                      <View className="list-title">{tenant.name}</View>
                      <View className="list-sub">离线改动仍归属这家公司</View>
                    </View>
                    <Badge tone="warn">{count} 条待提交</Badge>
                  </View>
                );
              })}
          </Card>
        </>
      )}

      <SectionTitle title="离线队列" hint="按时间序提交；冲突必须人工确认" />
      <Card>
        <View className="stats">
          <View className="stat">
            <View className="stat-value">{queue.total}</View>
            <View className="stat-label">全部</View>
          </View>
          <View className="stat">
            <View className="stat-value stat-warn">{queue.pending}</View>
            <View className="stat-label">待提交</View>
          </View>
          <View className="stat">
            <View className="stat-value stat-danger">{queue.conflicts}</View>
            <View className="stat-label">冲突</View>
          </View>
        </View>
        <View className="actions">
          <Button variant="ghost" onClick={() => setShowQueue(true)}>
            查看明细
          </Button>
          <Button onClick={() => void runSync()} loading={busy} disabled={!network.online}>
            {network.online ? "立即提交" : "等待联网"}
          </Button>
        </View>
        <View className="footnote">
          H5 落 IndexedDB，小程序 / App 落 Taro Storage；照片只存本地引用，恢复后直传对象存储。
        </View>
      </Card>

      <SectionTitle title="身份与审批" hint="身份只影响个性化，权限由服务端决定" />
      <Card>
        <View className="list-row" onClick={() => void switchRole()}>
          <View>
            <View className="list-title">当前身份</View>
            <View className="list-sub">影响「待办」的个性化，不影响权限</View>
          </View>
          <Text className="link">{ROLE_LABEL[role]}</Text>
        </View>
        <View className="list-row" onClick={() => setShowThreshold(true)}>
          <View>
            <View className="list-title">大额审批阈值</View>
            <View className="list-sub">超过即要求 Face ID / 生物识别二次验证</View>
          </View>
          <Text className="link">{formatMoneyShort(prefs.getLargeApprovalThresholdCents())}</Text>
        </View>
        <View
          className="list-row"
          onClick={() =>
            void Taro.showModal({
              title: "隐私",
              content:
                "图片与客户数据不上传第三方模型；手机号默认脱敏；token 只驻留内存，不落本地明文。",
              showCancel: false,
            })
          }
        >
          <View>
            <View className="list-title">隐私与数据说明</View>
            <View className="list-sub">色卡屏幕色仅供参考</View>
          </View>
          <Text className="link">查看</Text>
        </View>
      </Card>

      <SectionTitle title="应用" hint="PWA 可安装；小程序 / App 同一份代码" />
      <Card>
        <View className="list-row">
          <View>
            <View className="list-title">安装到桌面</View>
            <View className="list-sub">
              {install.installed
                ? "已安装（独立窗口运行）"
                : install.canInstall
                  ? "支持一键安装"
                  : "用浏览器菜单「添加到主屏幕」"}
            </View>
          </View>
          {install.installed ? (
            <Badge tone="accent">已安装</Badge>
          ) : (
            <Button
              small
              onClick={() => {
                void install.install().then((result) => {
                  if (result === "unavailable") {
                    void Taro.showToast({ title: "请用浏览器菜单添加到主屏幕", icon: "none" });
                  }
                });
              }}
            >
              安装
            </Button>
          )}
        </View>
        <View className="list-row">
          <View>
            <View className="list-title">当前设备</View>
            <View className="list-sub">
              {TARO_ENV === "h5" ? "手机浏览器" : "小程序"} · {IS_MOCK ? "演示数据" : "正式服务"}
            </View>
          </View>
          <Badge>{TARO_ENV === "h5" ? "网页版" : "小程序"}</Badge>
        </View>
        <View className="list-row">
          <View>
            <View className="list-title">网络</View>
            <View className="list-sub">{network.networkType}</View>
          </View>
          <Badge tone={network.online ? "accent" : "warn"}>
            {network.online ? "在线" : "离线"}
          </Badge>
        </View>
        <View className="footnote">
          PWA：manifest + Service Worker 已随 H5 构建输出；只缓存静态壳，不缓存 /api 鉴权响应。
        </View>
      </Card>

      <SectionTitle title="手机不做" hint="避免手机变成「什么都做一点」" />
      <Card className="card-flat">
        <View className="muted">
          批量导入、报价模板编辑、宽表全景、权限配置、审计全文检索、对账单批量调整。
        </View>
        <View className="footnote">这些在 PC 上 10 秒能做完，在手机上做是自虐。</View>
      </Card>

      <Sheet open={showQueue} title="离线队列" onClose={() => setShowQueue(false)}>
        {items.length === 0 ? (
          <View className="muted">没有待提交的操作。</View>
        ) : (
          items.map((op) => (
            <View key={op.opId} className="queue-item">
              <View className="row">
                <View>
                  <View className="list-title">{KIND_LABEL[op.kind] ?? op.kind}</View>
                  <View className="list-sub">
                    {relativeTime(op.createdAt)} · 尝试 {op.attempts} 次
                  </View>
                </View>
                <Badge tone={op.status === "conflict" ? "danger" : "warn"}>
                  {op.status === "conflict" ? "冲突" : "待提交"}
                </Badge>
              </View>
              {op.lastError && <View className="footnote">{op.lastError}</View>}
              {op.status === "conflict" && (
                <View className="conflict-box">
                  <View>
                    本地基于 v{op.baseVersion ?? "?"}，服务端已是 v{op.serverVersion ?? "?"}。
                    不会自动合并：请选择保留哪一版。
                  </View>
                  <View className="actions">
                    <Button
                      small
                      variant="ghost"
                      onClick={() => void resolveConflict(op, "server")}
                    >
                      保留服务端（丢弃本地）
                    </Button>
                    <Button small onClick={() => void resolveConflict(op, "local")}>
                      以服务端版本重试本地
                    </Button>
                  </View>
                </View>
              )}
              <View className="actions">
                <Button small variant="danger" onClick={() => void drop(op)}>
                  丢弃
                </Button>
              </View>
            </View>
          ))
        )}
        <View className="footnote">
          分享链接不排队：链接必须由服务端签发，离线时不会把 token 落本地。
        </View>
      </Sheet>

      <Sheet
        open={showThreshold}
        title="大额审批阈值"
        onClose={() => setShowThreshold(false)}
        footer={
          <Button block onClick={saveThreshold}>
            保存
          </Button>
        }
      >
        <View className="muted">
          超过该金额的批准会要求二次验证。仅影响本机展示，服务端仍有自己的审批上限。
        </View>
        <View className="label">阈值（元）</View>
        <Input
          className="input"
          type="digit"
          value={thresholdYuan}
          onInput={(event) => setThresholdYuan(event.detail.value)}
        />
      </Sheet>
    </Page>
  );
}
