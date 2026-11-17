// 构建期把版本信息固化进 dist/version.json，供 CLI 运行时读取。
// CLI 分发到用户机器后读不到 .git，所以版本必须在构建时确定：
//   - Docker 构建：镜像内无 .git，用 build_push_images.sh 传入的 APP_VERSION / GIT_COMMIT。
//   - 本地源码构建：用 git describe / rev-parse 实时读 tag 与 commit。
// dev/test（tsx / vitest 直接跑 src）没有 dist/version.json，commands.ts 会退到兜底值。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const repoRoot = join(here, "..", "..", "..");

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** 取第一个非空值（git 失败返回空串，不能靠 ?? 兜底）。 */
function pick(...values) {
  return values.find((v) => typeof v === "string" && v.trim() !== "")?.trim() ?? "";
}

const versionRaw = pick(
  process.env.APP_VERSION,
  git(["describe", "--tags", "--exact-match", "HEAD"]),
  git(["describe", "--tags", "--always", "--dirty"]),
  "0.1.0",
);
const version = versionRaw.replace(/^v/, ""); // 去 v 前缀，展示层自己拼，避免 vv0.1.8
const commit = pick(process.env.GIT_COMMIT, git(["rev-parse", "--short=12", "HEAD"]), "unknown");

mkdirSync(distDir, { recursive: true });
writeFileSync(
  join(distDir, "version.json"),
  JSON.stringify({ version, commit }, null, 2) + "\n",
);
console.log(`CLI 版本(构建期): v${version} · ${commit}`);
