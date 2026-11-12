import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/**
 * token / 设备码的生成与哈希。
 *
 * token 形态：`wo_<publicId>_<secret>`
 * - `publicId`（10 位小写 base32）用于数据库查找与界面展示；
 * - `secret`（32 位）只出现在明文里，数据库只存 `sha256(pepper + token)`；
 * - 比较用 `timingSafeEqual`，避免按字节比较泄露前缀。
 */

/** 去掉 0/o/1/l/i 等易混字符的 base32 字母表。 */
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

const PUBLIC_ID_LENGTH = 10;
const SECRET_LENGTH = 32;
const DEVICE_CODE_LENGTH = 40;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const TOKEN_PATTERN = new RegExp(
  `^wo_([${ALPHABET}]{${PUBLIC_ID_LENGTH}})_([${ALPHABET}]{${SECRET_LENGTH}})$`,
);

function randomString(length: number, alphabet: string = ALPHABET): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[randomInt(0, alphabet.length)];
  }
  return out;
}

export interface GeneratedToken {
  /** 明文 token，只返回一次。 */
  token: string;
  /** 数据库查找键。 */
  publicId: string;
}

export function generateApiToken(): GeneratedToken {
  const publicId = randomString(PUBLIC_ID_LENGTH);
  const secret = randomString(SECRET_LENGTH);
  return { token: `wo_${publicId}_${secret}`, publicId };
}

/** 解析明文 token；格式不对直接返回 null（不区分「格式错」与「不存在」，避免探测）。 */
export function parseApiToken(token: string): { publicId: string } | null {
  const match = TOKEN_PATTERN.exec(token.trim());
  return match?.[1] ? { publicId: match[1] } : null;
}

export function hashSecret(value: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}:${value}`).digest("hex");
}

export function hashToken(token: string, pepper: string): string {
  return hashSecret(token.trim(), pepper);
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** 常量时间比较两个十六进制哈希。长度不合法时直接判否（不抛错）。 */
export function hashesEqual(a: string, b: string): boolean {
  if (!HASH_PATTERN.test(a) || !HASH_PATTERN.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** CLI 的 device_code：高熵随机串，只以哈希形式落库。 */
export function generateDeviceCode(): string {
  return randomString(DEVICE_CODE_LENGTH);
}

/** 人类输入的短码，形如 `ABCD-EFGH`。 */
export function generateUserCode(): string {
  const raw = randomString(8, USER_CODE_ALPHABET);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** 归一化用户输入：大小写、空格、全角横线都容错，输出 `ABCD-EFGH`。 */
export function normalizeUserCode(input: string): string {
  const raw = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  if (raw.length <= 4) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
