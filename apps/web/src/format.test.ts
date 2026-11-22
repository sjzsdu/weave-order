import { describe, expect, it } from "vitest";
import {
  actionLabel,
  appVersionLabel,
  confirmedByLabel,
  footerBrandLabel,
  KIND_LABEL,
  ownerLabel,
  personLabel,
  ORDER_STATUS_LABEL,
  plainCents,
  RECEIVABLE_STATUS_LABEL,
  relativeTime,
  STATUS_LABEL,
} from "./format";

const SSO_SUBJECT = "9ba015a8-70a3-49e3-a7d9-73cdab4c0fac";

describe("桌面 Web 文案", () => {
  it("审计动作说人话", () => {
    expect(actionLabel("QUOTE_DRAFT_GENERATED")).toBe("生成了报价草稿");
    expect(actionLabel("SAMPLE_ARCHIVED")).toBe("归档了样品");
  });

  it("未映射动作走通用话术，不裸输出枚举", () => {
    expect(actionLabel("UNKNOWN_ACTION")).toBe("更新了一条记录");
    expect(actionLabel("UNKNOWN_ACTION")).not.toMatch(/^[A-Z_]+$/);
  });

  it("单据类型与状态有中文标签", () => {
    expect(KIND_LABEL.quote).toBe("报价");
    expect(STATUS_LABEL.DRAFT).toBe("草稿");
  });

  it("相对时间对非法输入不崩", () => {
    expect(relativeTime("not-a-date")).toBe("not-a-date");
  });

  it("页脚版本只显示真实注入的版本号", () => {
    expect(appVersionLabel("0.1.9")).toBe("v0.1.9");
    expect(appVersionLabel("v0.1.9")).toBe("v0.1.9");
    // 构建期没注入 / 本地 sha 构建：不显示，而不是回落到写死的旧版本。
    expect(appVersionLabel(undefined)).toBeNull();
    expect(appVersionLabel(" ")).toBeNull();
    expect(appVersionLabel("77b6ef4abcde")).toBeNull();
    expect(appVersionLabel("0.1")).toBeNull();
  });

  it("页脚只有可信版本才出现版本，commit 只作附注", () => {
    expect(footerBrandLabel("v0.1.9", "77b6ef4abcde")).toBe(
      "织序 WeaveOrder · v0.1.9 (77b6ef4abcde)",
    );
    expect(footerBrandLabel("v0.1.9")).toBe("织序 WeaveOrder · v0.1.9");
    // 没有版本时不留「· v」或「()」，也不拿 commit 顶替版本。
    expect(footerBrandLabel(null, "77b6ef4abcde")).toBe("织序 WeaveOrder");
    expect(footerBrandLabel(null, "")).toBe("织序 WeaveOrder");
  });

  it("整数分转元不做浮点运算", () => {
    expect(plainCents(0)).toBe("0.00");
    expect(plainCents(5)).toBe("0.05");
    expect(plainCents(123_456)).toBe("1234.56");
    expect(plainCents(-1_050)).toBe("-10.50");
  });

  it("订单与应收状态有中文标签", () => {
    expect(ORDER_STATUS_LABEL.IN_PRODUCTION).toBe("生产中");
    expect(RECEIVABLE_STATUS_LABEL.OVERDUE).toBe("逾期");
  });

  it("人员展示名过滤技术标识，UUID 不当名字用", () => {
    expect(personLabel("海宝", SSO_SUBJECT)).toBe("海宝");
    expect(personLabel(SSO_SUBJECT, "haibao@example.com")).toBe("haibao@example.com");
    expect(personLabel(" ", SSO_SUBJECT.replace(/-/g, ""))).toBeNull();
    expect(personLabel(null, undefined)).toBeNull();
  });

  it("确认人优先展示姓名，没有名字时兜底「我 / 同事」而不显示 subject", () => {
    // 后端给了展示名：直接用。
    expect(confirmedByLabel("海宝", SSO_SUBJECT, SSO_SUBJECT)).toBe("海宝");
    // 查不到姓名时，按 subject 判定是不是本人，但绝不显示 subject 本身。
    expect(confirmedByLabel(null, SSO_SUBJECT, SSO_SUBJECT)).toBe("我");
    expect(confirmedByLabel(SSO_SUBJECT, SSO_SUBJECT, "other-subject")).toBe("同事");
    expect(confirmedByLabel(null, null)).toBe("—");
  });

  it("负责人展示名同样过滤 UUID，未分配时不假装有人", () => {
    expect(ownerLabel("张三", null)).toBe("张三");
    expect(ownerLabel(SSO_SUBJECT, "membership-1", "membership-1")).toBe("我");
    expect(ownerLabel(SSO_SUBJECT, null)).toBe("未分配");
  });
});
