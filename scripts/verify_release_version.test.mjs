/**
 * scripts/verify_release_version.mjs 的纯逻辑用例（不发请求）。
 *
 * 这个脚本是发布验收的最后一道人工关：它必须能区分「版本对」「版本旧」「没有注入版本」
 * 三种情况，否则又变成一条看起来在检查、其实永远通过的命令。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { judgeVersion, normalizeVersion } from "./verify_release_version.mjs";

test("版本号规范化：接受带 v / 不带 v，拒绝 sha 与两段式", () => {
  assert.equal(normalizeVersion("0.1.9"), "v0.1.9");
  assert.equal(normalizeVersion("v0.1.9"), "v0.1.9");
  assert.equal(normalizeVersion(" 1.10.0 "), "v1.10.0");
  assert.equal(normalizeVersion("0.1.9-rc.1"), "v0.1.9-rc.1");
  assert.equal(normalizeVersion("77b6ef4abcde"), null);
  assert.equal(normalizeVersion("0.1"), null);
  assert.equal(normalizeVersion(""), null);
  assert.equal(normalizeVersion(undefined), null);
});

test("线上版本与发布 tag 一致才通过", () => {
  assert.equal(judgeVersion({ expected: "v0.1.9", actual: "v0.1.9" }).ok, true);
  assert.equal(judgeVersion({ expected: "0.1.9", actual: "v0.1.9" }).ok, true);
});

test("线上还是旧版本时失败，并指出线上与期望各是什么", () => {
  const verdict = judgeVersion({ expected: "v0.1.9", actual: "v0.1.0" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /线上 v0\.1\.0/);
  assert.match(verdict.message, /期望 v0\.1\.9/);
});

test("没有版本头（没注入 / 旧镜像）时失败，而不是当成通过", () => {
  const verdict = judgeVersion({ expected: "v0.1.9", actual: null });
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /x-weave-version/);
});

test("头里的值不可信时失败", () => {
  assert.equal(judgeVersion({ expected: "v0.1.9", actual: "77b6ef4abcde" }).ok, false);
});

test("期望版本写错时先拦住命令行本身", () => {
  assert.equal(judgeVersion({ expected: "latest", actual: "v0.1.9" }).ok, false);
});
