/**
 * 发布验收：核对线上响应头里的构建期版本号。
 *
 * 用法：node scripts/verify_release_version.mjs <base-url> <expected-tag> [timeoutMs]
 *   node scripts/verify_release_version.mjs https://app.wnbgj.com v0.1.9
 *
 * 为什么不直接 curl 页脚：桌面壳的页脚只有登录后才渲染，`/today` 未登录是 307，
 * 登录页又不带桌面壳页脚 —— 抓页面永远看不到版本号，于是「页脚版本对不对」在发布
 * 之后根本没法验。middleware 给每个响应带上 `x-weave-version`，这个检查才真的可跑。
 * 没注入版本（本地 / sha 构建）时没有这个头，脚本按失败处理：发布必须来自 tag。
 */
import { pathToFileURL } from "node:url";

export const VERSION_HEADER = "x-weave-version";

export function normalizeVersion(raw) {
  const value = (raw ?? "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) return null;
  return `v${value}`;
}

export function judgeVersion({ expected, actual }) {
  const want = normalizeVersion(expected);
  if (!want) {
    return { ok: false, message: `期望版本不合法：${expected ?? "（空）"}（要形如 v0.1.9）` };
  }
  if (!actual) {
    return {
      ok: false,
      message: `线上没有 ${VERSION_HEADER} 响应头：镜像没有注入 APP_VERSION（不是用 tag 构建的），或者部署的还是旧版本。`,
    };
  }
  const got = normalizeVersion(actual);
  if (!got) {
    return { ok: false, message: `线上 ${VERSION_HEADER} 的值不可信：${actual}` };
  }
  if (got !== want) {
    return {
      ok: false,
      message: `版本不一致：线上 ${got}，期望 ${want}。检查 WEAVE_TAG 是否指向新 tag，以及镜像是否真的重新构建过。`,
    };
  }
  return { ok: true, message: `✔ 线上版本 ${got} 与发布 tag 一致` };
}

async function main() {
  const [baseUrl, expected, timeoutArg] = process.argv.slice(2);
  if (!baseUrl || !expected) {
    console.error(
      "用法: node scripts/verify_release_version.mjs <base-url> <expected-tag> [timeoutMs]",
    );
    process.exit(2);
  }

  // /login 免登录（middleware 的 PUBLIC_PREFIXES），拿到的就是被测镜像发出的头。
  const url = new URL("/login", baseUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutArg ?? 10000));

  let actual = null;
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
    actual = response.headers.get(VERSION_HEADER);
    if (!response.ok && response.status !== 307 && response.status !== 308) {
      console.error(`✘ ${url} 返回 ${response.status}，先确认部署起来了再验版本`);
      process.exit(1);
    }
  } catch (cause) {
    console.error(`✘ 请求 ${url} 失败：${cause instanceof Error ? cause.message : cause}`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }

  const verdict = judgeVersion({ expected, actual });
  console.log(verdict.ok ? verdict.message : `✘ ${verdict.message}`);
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
