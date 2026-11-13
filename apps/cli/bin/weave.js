#!/usr/bin/env node
"use strict";

// 薄启动器：真正的实现在 dist/main.js（pnpm build 生成）。
// 找不到 dist 时给出可执行的提示，而不是一句 MODULE_NOT_FOUND。
let entry;
try {
  entry = require("../dist/main.js");
} catch (error) {
  if (error && error.code === "MODULE_NOT_FOUND") {
    console.error("weave CLI 尚未构建：请先运行 `pnpm --filter @weave-order/cli build`");
    process.exit(1);
  }
  throw error;
}

entry.main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
