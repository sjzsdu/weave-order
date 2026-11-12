// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * 目录边界铁律（机器强制，不靠自觉）：
 * 1. apps/api/src/agent 只能 import tools，禁止 import kernel，也禁止触达数据库。
 * 2. apps/api/src/tools、approval 只能调用 kernel service，禁止直连数据库。
 * 3. 只有 kernel / platform 可以拥有数据库连接。
 */
const DATABASE_PATTERNS = [
  "drizzle-orm",
  "drizzle-orm/*",
  "@weave-order/db",
  "@weave-order/db/**",
  "pg",
  "**/platform/database",
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/*.config.js",
      "**/*.config.mjs",
      "**/*.config.cjs",
      "**/*.config.ts",
      "packages/db/drizzle/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // 铁律 #1 / #3：智能体不碰内核，也不碰数据库。
    files: ["apps/api/src/agent/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/kernel", "**/kernel/**"],
              message: "目录边界铁律：agent 层禁止直接 import kernel，只能通过 tools 接口调用。",
            },
            {
              group: DATABASE_PATTERNS,
              message:
                "目录边界铁律：agent 层禁止触达数据库（drizzle/pg/@weave-order/db），只能通过 tools 调用内核。",
            },
          ],
        },
      ],
    },
  },
  {
    // 工具层只能调用 kernel service，不得自己连数据库。
    files: ["apps/api/src/tools/**/*.ts", "apps/api/src/approval/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: DATABASE_PATTERNS,
              message: "目录边界铁律：tools/approval 只调用 kernel service，禁止直连数据库。",
            },
          ],
        },
      ],
    },
  },
);
