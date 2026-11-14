#!/usr/bin/env node
/**
 * 生产构建门禁：三道断言，任何一道不过就让构建失败。
 *
 * 1. 产物里不允许出现 mock 服务端的任何痕迹。
 *    mock 是「无鉴权的演示数据」，误交付等于把演示租户的数据暴露给真实用户。
 *    `runtime.ts` 里 IS_MOCK 在 NODE_ENV=production 时被折叠为 false，
 *    这里再对产物做一次字符串级断言，防止 tree-shaking 失效时静默放过。
 *
 * 2. 产物必须是浏览器能解析的合法 JavaScript。
 *    教训：Taro 默认 terser 配置带 output.quote_keys:true，Terser 会把 ES 私有类字段
 *    （@tanstack/react-query 的 #client / #mutationId 等）输出成 `#"client"` ——
 *    私有名的规范形式是 `# IdentifierName`，字符串字面量不合法。浏览器解析时抛
 *    SyntaxError: Invalid or unexpected token，整个 app bundle 挂掉 → 页面永久白屏。
 *    压缩器、依赖版本一变就复发，所以这里用 node:vm 真编译一遍，
 *    不做字符串模式匹配：换压缩器、换依赖也照样拦得住。
 *
 * 3. 生产构建必须固化正确的公网 API 基址。
 *    教训：turbo 2.x 默认 strict env 模式，只透传 turbo.json globalEnv 里声明过的变量。
 *    TARO_APP_API_BASE 漏声明时构建不报错，但会静默回退成 http://localhost:3000，
 *    页面能打开、接口全打本机 —— 同样是「构建全绿、上线才发现」的那类故障。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const distDir = path.resolve(process.env.TARO_APP_OUTPUT ?? "dist");
const isProduction = process.env.NODE_ENV === "production";

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

const files = [];
for await (const file of walk(distDir)) files.push(file);

/**
 * 取语法错误所在行号。
 * vm.Script 抛的 SyntaxError 没有 lineNumber，但 stack 首行形如 `文件名:行号`。
 */
function errorLine(error, file) {
  if (typeof error.lineNumber === "number") return error.lineNumber;
  const match = new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`).exec(
    String(error.stack ?? ""),
  );
  return match ? match[1] : "?";
}

const errors = [];

// ---- 断言 1：产物里没有 mock 痕迹 ----
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const sentinel of SENTINELS) {
    if (text.includes(sentinel)) errors.push(`${path.relative(distDir, file)}: 含 mock 代码 ${sentinel}`);
  }
}

// ---- 断言 2：产物是浏览器能解析的合法 JS ----
for (const file of files) {
  const text = await readFile(file, "utf8");
  try {
    // 只编译不执行：等价于浏览器的解析阶段，能捕获词法/语法错误。
    new vm.Script(text, { filename: file });
  } catch (error) {
    errors.push(
      `${path.relative(distDir, file)}: 浏览器无法解析（第 ${errorLine(error, file)} 行）→ ${error.message}\n` +
        "    若产物里出现 #\"xxx\" 这类写法，是 Terser 的 output.quote_keys 把 ES 私有字段\n" +
        "    输出成了字符串字面量（非法 JS）。检查 config/index.ts 的 terser 配置。",
    );
  }
}

// ---- 断言 3：生产构建固化了正确的公网 API 基址 ----
if (isProduction) {
  const expected = process.env.TARO_APP_API_BASE;
  if (!expected) {
    errors.push(
      "生产构建未设置 TARO_APP_API_BASE：无法确认 PWA 会请求哪个后端。\n" +
        "    请在 turbo.json 的 globalEnv 里声明它（turbo strict 模式只透传已声明的变量），\n" +
        "    并通过构建环境传入公网 API 基址。",
    );
  } else {
    let found = false;
    for (const file of files) {
      if ((await readFile(file, "utf8")).includes(expected)) {
        found = true;
        break;
      }
    }
    if (!found) {
      errors.push(
        `生产产物里找不到 API 基址 ${expected}：TARO_APP_API_BASE 没有真正固化进产物。\n` +
          "    常见原因：turbo strict env 模式下该变量未在 turbo.json globalEnv 中声明。",
      );
    }
  }
}

if (errors.length > 0) {
  console.error("✗ 生产构建产物未通过门禁，拒绝交付：");
  for (const error of errors) console.error(`  - ${error}`);
  console.error(
    "  检查 apps/mobile/src/lib/runtime.ts 的 IS_MOCK 门禁、config/index.ts 的 terser 配置，\n" +
      "  以及 turbo.json globalEnv 是否声明了 TARO_APP_API_BASE。",
  );
  process.exit(1);
}

console.log(
  `✓ 产物通过门禁：无 mock 代码、语法可解析、API 基址已固化（扫描 ${distDir}，${files.length} 个 js）`,
);
