/**
 * scripts/build-version.sh 的用例：在真实 git 仓库里跑版本推导。
 *
 * 这条规则决定页脚显示哪个版本，错一次就是把错的版本发给用户（WAN-152 的原始 bug），
 * 所以用临时仓库覆盖「语义化 tag / 无 tag / 非版本 tag / tag 在别的提交」四种情况。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "build-version.sh");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function commit(cwd, message) {
  writeFileSync(path.join(cwd, "README.md"), `${message}\n`, { flag: "a" });
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "--short=12", "HEAD");
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "weave-build-version-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(path.join(dir, "README.md"), "init\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** 在临时仓库里 source 推导脚本，取 APP_VERSION / GIT_COMMIT（带 key，空值也读得出来）。 */
function derive(dir) {
  const out = execFileSync(
    "bash",
    ["-c", `source "${helper}"; printf 'version=%s\\ncommit=%s\\n' "$APP_VERSION" "$GIT_COMMIT"`],
    { cwd: dir, encoding: "utf8" },
  );
  const fields = Object.fromEntries(
    out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return { version: fields.version, gitCommit: fields.commit };
}

test("HEAD 上是 v0.1.9 这种发布 tag → 注入 0.1.9", () => {
  const dir = makeRepo();
  const sha = commit(dir, "second");
  git(dir, "tag", "v0.1.9");
  assert.deepEqual(derive(dir), { version: "0.1.9", gitCommit: sha });
});

test("tag 不带宽前缀也认（0.1.9）", () => {
  const dir = makeRepo();
  git(dir, "tag", "0.1.9");
  assert.equal(derive(dir).version, "0.1.9");
});

test("预发布 tag 也认，且与 verify_release_version.mjs 的口径一致", () => {
  const dir = makeRepo();
  git(dir, "tag", "v0.1.9-rc.1");
  assert.equal(derive(dir).version, "0.1.9-rc.1");
});

test("没有 tag（main 的 sha 构建）→ 不注入版本，页脚不显示", () => {
  const dir = makeRepo();
  commit(dir, "second");
  const { version, gitCommit } = derive(dir);
  assert.equal(version, "");
  assert.equal(gitCommit, git(dir, "rev-parse", "--short=12", "HEAD"));
});

test("非版本 tag（latest / 1.0）不算版本", () => {
  for (const tag of ["latest", "1.0", "v1.0"]) {
    const dir = makeRepo();
    git(dir, "tag", tag);
    assert.equal(derive(dir).version, "", `tag ${tag} 不该被当成版本`);
  }
});

test("tag 打在别的提交上（当前 HEAD 未打 tag）→ 不注入版本", () => {
  const dir = makeRepo();
  git(dir, "tag", "v0.1.9");
  commit(dir, "after-release");
  assert.equal(derive(dir).version, "");
});
