#!/usr/bin/env node
/**
 * 生产构建门禁：产物里不允许出现 mock 服务端的任何痕迹。
 *
 * mock 是「无鉴权的演示数据」，误交付等于把演示租户的数据暴露给真实用户。
 * `runtime.ts` 里 IS_MOCK 在 NODE_ENV=production 时被折叠为 false，
 * 这里再对产物做一次字符串级断言，防止 tree-shaking 失效时静默放过。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const distDir = path.resolve(process.env.TARO_APP_OUTPUT ?? "dist");

/**
 * mock 模块独有的字符串：种子数据 / 存储键 / 演示单据。
 * 只放 `src/lib/mock/**` 的特征串，其他包（如 @weave-order/core 的 mock-client）
 * 不在本门禁范围内。
 */
const SENTINELS = [
  "00000000-0000-4000-8000-000000000001", // MOCK_TENANT_ID
  "weave.mock.state", // MOCK_STATE_KEY
  "报价 · 青禾服饰", // 演示单据标题，只存在于 mock/seed.ts
];

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith(".js")) yield full;
  }
}

const hits = [];
for await (const file of walk(distDir)) {
  const text = await readFile(file, "utf8");
  for (const sentinel of SENTINELS) {
    if (text.includes(sentinel)) hits.push(`${path.relative(distDir, file)}: ${sentinel}`);
  }
}

if (hits.length > 0) {
  console.error("✗ 生产构建产物包含 mock 代码，拒绝交付：");
  for (const hit of hits) console.error(`  - ${hit}`);
  console.error(
    "  检查 apps/mobile/src/lib/runtime.ts 的 IS_MOCK 门禁，以及 config/index.ts 的 NODE_ENV 定义。",
  );
  process.exit(1);
}

console.log(`✓ 产物无 mock 代码（扫描 ${distDir}）`);
