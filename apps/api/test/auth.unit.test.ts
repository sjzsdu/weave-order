import { describe, expect, it } from "vitest";
import {
  generateApiToken,
  generateDeviceCode,
  generateUserCode,
  hashesEqual,
  hashToken,
  normalizeUserCode,
  parseApiToken,
} from "../src/auth/crypto";

const PEPPER = "test-pepper";

describe("凭据生成与校验（单元）", () => {
  it("生成的 token 可解析回 publicId，且 secret 不可从 publicId 推出", () => {
    const generated = generateApiToken();
    expect(generated.token).toMatch(/^wo_[a-z0-9]{10}_[a-z0-9]{32}$/);
    expect(parseApiToken(generated.token)).toEqual({ publicId: generated.publicId });
    expect(generated.token).not.toContain(generated.publicId + generated.publicId);
  });

  it("两次生成不会重复", () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateApiToken().token));
    expect(ids.size).toBe(200);
  });

  it("格式不合法的 token 一律解析失败（不区分错误原因，避免探测）", () => {
    expect(parseApiToken("")).toBeNull();
    expect(parseApiToken("Bearer wo_abc_def")).toBeNull();
    expect(parseApiToken("wo_ABCDEFGHIJ_short")).toBeNull();
    expect(parseApiToken("wo_0123456789_" + "a".repeat(32))).toBeNull(); // 0/1 不在字母表
  });

  it("哈希受 pepper 影响，且比较是常量时间语义", () => {
    const token = generateApiToken().token;
    const a = hashToken(token, PEPPER);
    const b = hashToken(token, "another-pepper");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(hashesEqual(a, hashToken(token, PEPPER))).toBe(true);
    expect(hashesEqual(a, b)).toBe(false);
    expect(hashesEqual(a, "not-a-hash")).toBe(false);
  });

  it("用户码归一化：大小写、空格、横线都容错", () => {
    expect(normalizeUserCode("abcd-efgh")).toBe("ABCD-EFGH");
    expect(normalizeUserCode("ABCD EFGH")).toBe("ABCD-EFGH");
    expect(normalizeUserCode("abcdefgh")).toBe("ABCD-EFGH");
    expect(normalizeUserCode("ab-cd")).toBe("ABCD");
  });

  it("用户码与设备码都是高熵字符串", () => {
    expect(generateUserCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(generateDeviceCode()).toHaveLength(40);
    expect(generateDeviceCode()).not.toBe(generateDeviceCode());
  });
});
