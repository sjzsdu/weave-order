import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Next.js 从 tsconfig 的 paths 解析 `@/*`（指向应用根目录），vitest 不读 tsconfig，
 * 这里补上同一套别名，测试里的 import 路径与应用代码保持一致。
 * 详见 apps/admin/tsconfig.json 的 compilerOptions.paths。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
