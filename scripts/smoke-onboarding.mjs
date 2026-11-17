#!/usr/bin/env node
/**
 * 生产冒烟：已登录用户能否打开邀请 / 开通链接（WAN-148）。
 *
 * 背景：这两个端点曾只认裸 OIDC 令牌，而浏览器经 BFF 进来时网关只传
 * `Bearer session:<sid>`，于是所有已登录用户都撞 401 "Invalid Compact JWS"。
 *
 * 用法：
 *   node scripts/smoke-onboarding.mjs --base https://app.wnbgj.com --cookie "weave_sid=..."
 *   node scripts/smoke-onboarding.mjs --base https://app.wnbgj.com --cookie "..." --code "<邀请链接里的 code>"
 *
 * - 不给 --code：`/api/onboarding/invite/preview` 返回 400「缺少邀请链接」即说明鉴权已通过；
 *   401 视为失败（会话链路又断了）。
 * - 给 --code：必须 200，且返回公司名 / 角色 / 有效期。这是发布后真正要看到的结果。
 *
 * `weave_sid` 从浏览器开发者工具里取（Cookie 是 httpOnly，脚本读不到）。
 */
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const base = (option("base") ?? "https://app.wnbgj.com").replace(/\/$/, "");
const cookie = option("cookie");
const code = option("code");

if (!cookie) {
  console.error(
    '用法：node scripts/smoke-onboarding.mjs --cookie "weave_sid=..." [--code "<邀请 code>"]',
  );
  process.exit(2);
}

async function request(path) {
  const response = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json", Cookie: cookie },
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function fail(message, detail) {
  console.error(`✘ ${message}`);
  if (detail) console.error(JSON.stringify(detail));
  process.exit(1);
}

const me = await request("/api/auth/me");
if (me.status !== 200) {
  fail(`会话不可用（/api/auth/me → ${me.status}），先重新登录再跑`, me.body);
}
console.log(`✔ 会话有效：${me.body?.tenant?.name ?? "未绑定公司"}`);

const path = code
  ? `/api/onboarding/invite/preview?code=${encodeURIComponent(code)}`
  : "/api/onboarding/invite/preview";
const preview = await request(path);

if (code) {
  if (preview.status !== 200) {
    fail(`邀请预览必须 200，实际 ${preview.status}`, preview.body);
  }
  const { tenantName, role, expiresAt } = preview.body ?? {};
  console.log(`✔ 邀请预览可用：${tenantName} / ${role} / 至 ${expiresAt}`);
} else {
  if (preview.status === 401) {
    fail("邀请预览仍返回 401：会话凭据没被开通端点接受", preview.body);
  }
  if (preview.status !== 400) {
    fail(`未给 --code 时预期 400（缺少邀请链接），实际 ${preview.status}`, preview.body);
  }
  console.log("✔ 鉴权通过：缺 code 时返回 400 而不是 401（补 --code 可验证完整预览）");
}
