import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = readFileSync(path.join(root, "infra/test-env/docker-compose.yml"), "utf8");
const envExample = readFileSync(path.join(root, "infra/test-env/.env.test.example"), "utf8");

test("测试环境与生产同镜像：所有应用服务都引用同一个 WEAVE_IMAGE", () => {
  const imageLines = compose.split("\n").filter((line) => /^\s+image:/.test(line));
  assert.equal(imageLines.length, 1);
  assert.match(imageLines[0], /\$\{WEAVE_IMAGE:\?/);
});

test("测试环境与生产同构：NODE_ENV=production + AUTH_MODE=oidc", () => {
  assert.match(compose, /NODE_ENV:\s*production/);
  assert.match(compose, /AUTH_MODE:\s*oidc/);
  assert.match(compose, /SESSION_STORE:\s*redis/);
});

test("只有测试环境显式标记 WEAVE_ENV=test", () => {
  assert.match(compose, /WEAVE_ENV:\s*test/);
  assert.match(envExample, /WEAVE_ENV=test/);
  assert.doesNotMatch(compose, /WEAVE_ENV:\s*production/);
});

test("测试环境使用独立库 / Redis / 对象存储变量，不引用生产变量名", () => {
  for (const key of ["DATABASE_URL", "APP_DATABASE_URL", "REDIS_URL", "S3_BUCKET"]) {
    assert.match(compose, new RegExp(`TEST_${key}`));
  }
  assert.doesNotMatch(compose, /\$\{(DATABASE_URL|REDIS_URL|S3_BUCKET):/);
});

test("demo-reset 用同一个镜像，且不在 up 时自动执行", () => {
  assert.match(compose, /demo-reset:[\s\S]*?profiles:\s*\["tools"\]/);
  assert.match(compose, /command:\s*\["pnpm",\s*"demo:reset"\]/);
});
