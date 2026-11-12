import { describe, expect, it } from "vitest";
import {
  createShareToken,
  hashAnonymous,
  hashToken,
  parseShareToken,
} from "../src/kernel/share-token";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SHARE = "22222222-2222-4222-8222-222222222222";
const SECRET = "unit-test-secret-at-least-32-bytes-long";

describe("报价分享 token", () => {
  it("签名 token 可解析出 tenantId / shareId，且只存哈希", () => {
    const { token, tokenHash } = createShareToken({ t: TENANT, s: SHARE }, SECRET);
    expect(tokenHash).toBe(hashToken(token));
    expect(tokenHash).toHaveLength(64);
    expect(token).not.toContain(TENANT);
    expect(parseShareToken(token, SECRET)).toMatchObject({ t: TENANT, s: SHARE });
  });

  it("篡改 payload / 签名、换密钥、格式错误一律拒绝", () => {
    const { token } = createShareToken({ t: TENANT, s: SHARE }, SECRET);
    const [payload, signature] = token.split(".");
    const tamperedPayload = `${payload!.slice(0, -1)}A.${signature}`;
    expect(parseShareToken(tamperedPayload, SECRET)).toBeNull();
    expect(parseShareToken(`${payload}.${signature}AA`, SECRET)).toBeNull();
    expect(parseShareToken(token, `${SECRET}-other`)).toBeNull();
    expect(parseShareToken("not-a-token", SECRET)).toBeNull();
    expect(parseShareToken("", SECRET)).toBeNull();
  });

  it("每次生成的 token 都不同（随机 nonce）", () => {
    const first = createShareToken({ t: TENANT, s: SHARE }, SECRET);
    const second = createShareToken({ t: TENANT, s: SHARE }, SECRET);
    expect(first.token).not.toBe(second.token);
  });

  it("匿名标识加盐哈希稳定且不可逆", () => {
    const a = hashAnonymous("203.0.113.7", SECRET);
    const b = hashAnonymous("203.0.113.7", SECRET);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
    expect(a).not.toContain("203.0.113.7");
    expect(hashAnonymous("203.0.113.8", SECRET)).not.toBe(a);
  });
});
