import { cpSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * 把导出层的内嵌字体拷进 dist。
 *
 * `tsc` 只编译 TS，不搬二进制资源；如果不拷，`node dist/main.js` 时
 * `export/pdf.ts` 找不到 `assets/NotoSansSC-Subset.ttf`。
 * 用 `__dirname` 相对定位，所以 src 与 dist 用的是同一段路径逻辑。
 */
const here = __dirname;
const apiRoot = path.resolve(here, "..");
const from = path.join(apiRoot, "src", "export", "assets");
const to = path.join(apiRoot, "dist", "export", "assets");

if (!existsSync(from)) {
  console.error(`✖ 找不到导出资源目录：${from}`);
  process.exit(1);
}

cpSync(from, to, { recursive: true });
console.log(`✔ 导出资源已复制 → ${path.relative(apiRoot, to)}`);
