import { describe, expect, it } from "vitest";
import { friendlyLoginError } from "./login-error";

describe("登录失败文案", () => {
  it("不把内部组织名与「不存在」原样抛给用户", () => {
    const message = friendlyLoginError("用户: weave-order/nonexistent_user_xyz不存在");
    expect(message).toContain("账号不存在");
    expect(message).not.toContain("weave-order/");
    expect(message).not.toContain("nonexistent_user_xyz");
  });

  it("密码错误与账号不存在分开说", () => {
    expect(friendlyLoginError("密码错误")).toContain("账号或密码不正确");
    expect(friendlyLoginError("invalid_grant")).toContain("登录没有完成");
  });

  it("保留我们自己产生的中文说明", () => {
    expect(friendlyLoginError("缺少授权码")).toBe("缺少授权码");
    expect(friendlyLoginError("")).toBe("");
    expect(friendlyLoginError(undefined)).toBe("");
  });

  it("过长的异常原文不再整段展示", () => {
    const message = friendlyLoginError("x".repeat(200));
    expect(message).not.toContain("xxxx");
    expect(message).toContain("登录没有完成");
  });
});
