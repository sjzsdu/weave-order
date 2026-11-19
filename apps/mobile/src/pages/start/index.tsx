import { Input, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";
import { Button, Card, Page } from "../../components/ui";
import { openWorkspace } from "../../routes";
import { api, loadTenantContext } from "../../lib/runtime";

export default function StartPage() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const tenantName = name.trim();
    if (tenantName.length < 2) {
      setError("公司名称至少填写 2 个字符");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.startTenant({
        name: tenantName,
        ...(slug.trim() ? { slug: slug.trim().toLowerCase() } : {}),
      });
      await loadTenantContext();
      void Taro.showToast({ title: `${result.tenantName} 已开通`, icon: "success" });
      openWorkspace();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <View className="page-title">创建你的公司空间</View>
      <View className="page-sub">完成注册后再创建公司，即可进入织序工作台。</View>

      <Card>
        <View className="label">公司名称</View>
        <Input
          className="input"
          value={name}
          maxlength={120}
          placeholder="例如：青禾纺织"
          onInput={(event) => setName(event.detail.value)}
        />
        <View className="label">公司标识（选填）</View>
        <Input
          className="input"
          value={slug}
          maxlength={64}
          placeholder="qinghe"
          onInput={(event) => setSlug(event.detail.value)}
        />
        <View className="footnote">2–64 位小写字母、数字或连字符；不填则自动生成。</View>

        {error && <View style={{ color: "#b3261e", marginTop: 16 }}>{error}</View>}

        <View className="actions">
          <Button
            block
            loading={busy}
            disabled={name.trim().length < 2}
            onClick={() => void submit()}
          >
            创建公司并进入
          </Button>
        </View>
      </Card>

      <View className="footnote">已经有同事邀请你？请打开邀请链接加入已有公司，不要重复创建。</View>
    </Page>
  );
}
