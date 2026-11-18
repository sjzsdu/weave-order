import { describe, expect, it } from "vitest";
import {
  featureFlagPayload,
  parseTenantIds,
  validateFeatureFlagDraft,
  type FeatureFlagDraft,
} from "./feature-flag";

const base: FeatureFlagDraft = {
  key: "billing.overage_preview",
  name: "超额用量预览",
  description: "灰度给部分租户",
  rollout: "20",
  tenantIds: "",
  enabled: false,
};

const TENANT_A = "0b7d3c2e-9f11-4a52-8d0a-1f2e3d4c5b6a";
const TENANT_B = "6c1f8e42-2b3d-4c59-9a71-00aa11bb22cc";

describe("parseTenantIds", () => {
  it("接受中英文逗号与空白分隔，忽略空项", () => {
    expect(parseTenantIds(`${TENANT_A}, ${TENANT_B}`)).toEqual([TENANT_A, TENANT_B]);
    expect(parseTenantIds(`${TENANT_A}，${TENANT_B}`)).toEqual([TENANT_A, TENANT_B]);
    expect(parseTenantIds("  ")).toEqual([]);
  });
});

describe("validateFeatureFlagDraft", () => {
  it("完整内容通过校验", () => {
    expect(validateFeatureFlagDraft(base)).toEqual([]);
    expect(
      validateFeatureFlagDraft({ ...base, tenantIds: TENANT_A, rollout: "100" }),
    ).toEqual([]);
  });

  it("缺 key 与名称时同时报告所有问题", () => {
    const problems = validateFeatureFlagDraft({ ...base, key: " ", name: "" });
    expect(problems.map((item) => item.label)).toEqual(["开关 Key", "名称"]);
    expect(problems.every((item) => item.message === "请填写")).toBe(true);
  });

  it("key 必须是字母数字开头，只含点/下划线/短横线", () => {
    for (const key of ["-bad", "has space", "中文开关", "a/b"]) {
      expect(validateFeatureFlagDraft({ ...base, key }).length).toBeGreaterThan(0);
    }
    expect(validateFeatureFlagDraft({ ...base, key: "Flag_1.2-3" })).toEqual([]);
  });

  it("灰度比例必须是 0-100 的整数", () => {
    for (const rollout of ["", "-1", "101", "12.5", "abc"]) {
      const problems = validateFeatureFlagDraft({ ...base, rollout });
      expect(problems).toEqual([{ label: "灰度比例", message: "请填写 0 到 100 之间的整数" }]);
    }
  });

  it("租户 ID 不是 UUID 时指出是哪一项", () => {
    const problems = validateFeatureFlagDraft({ ...base, tenantIds: `${TENANT_A}, not-a-uuid` });
    expect(problems).toEqual([{ label: "指定租户", message: "不是有效的租户 ID：not-a-uuid" }]);
  });

  it("说明超过 500 字符被拒绝", () => {
    const problems = validateFeatureFlagDraft({ ...base, description: "x".repeat(501) });
    expect(problems).toEqual([{ label: "说明", message: "不能超过 500 个字符" }]);
  });
});

describe("featureFlagPayload", () => {
  it("裁剪空白并把输入框里的字符串转成契约里的类型", () => {
    expect(
      featureFlagPayload({
        ...base,
        key: "  flag.one  ",
        name: "  开关一  ",
        description: "  ",
        rollout: " 15 ",
        tenantIds: TENANT_A,
        enabled: true,
      }),
    ).toEqual({
      key: "flag.one",
      name: "开关一",
      enabled: true,
      rolloutPercent: 15,
      tenantIds: [TENANT_A],
    });
  });
});
