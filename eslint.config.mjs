// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * 目录边界铁律（机器强制，不靠自觉）：
 * 0. 「只有内核能写业务表」覆盖 apps/api/src 全目录：除 kernel / platform 外，
 *    任何文件都不得 import drizzle-orm / pg / @weave-order/db / platform/database。
 *    打印中心原本是第二写库者（print/ 直接读写 print_jobs、printers 等业务表），
 *    已并入 kernel/print：写入回到内核，print ↔ kernel 的双向依赖也一并消失。
 *    演示身份目录（原 dev/demo-identity）与样卡公开读（原 shares/public-sample-card）
 *    同理收进 kernel。
 * 1. apps/api/src/agent 只能 import tools，禁止 import kernel，也禁止触达数据库。
 * 2. apps/api/src/tools、approval、import 只能调用 kernel service / 做解析，禁止直连数据库。
 * 3. apps/api/src/http 不得直连数据库；唯一例外是 http 的组合根（http.module.ts 装配 +
 *    database.provider.ts 建连接），它们只能 import ../platform/database，仍不许直接碰 pg。
 * 4. 只有 kernel / platform 可以拥有数据库连接；kernel 还是业务表的唯一写入者。
 */
const DATABASE_PATTERNS = [
  "drizzle-orm",
  "drizzle-orm/*",
  "@weave-order/db",
  "@weave-order/db/**",
  "pg",
  "**/platform/database",
];

/**
 * 组合根豁免：只放开 `../platform/database` 这一条（连接由 platform 提供），
 * `pg` / `drizzle-orm` / `@weave-order/db` 对所有文件一律禁止。
 * 这是有意的例外，不是漏配；不要扩大下面的 files 列表。
 */
const COMPOSITION_ROOT_ALLOWED = "**/platform/database";
const COMPOSITION_ROOT_FORBIDDEN = DATABASE_PATTERNS.filter(
  (pattern) => pattern !== COMPOSITION_ROOT_ALLOWED,
);

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      // Taro 的 gate 构建产物（已 gitignore），里面是打包后的 JS，不是源码
      "**/dist-gate/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "**/*.cjs",
      "**/.turbo/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "**/coverage/**",
      // CLI 启动器是纯 JS 薄壳，不进 TS project service（逻辑在 src/）。
      "apps/cli/bin/**",
      "**/*.config.js",
      "**/*.config.mjs",
      "**/*.config.cjs",
      "**/*.config.ts",
      // 纯 Node ESM 运维脚本不参与类型检查（不在任何 tsconfig 的 project 里），
      // 由 prettier 统一风格；CI 用例见 scripts/ 与 apps/mobile/scripts/。
      "**/scripts/**/*.mjs",
      // 官网（apps/site）是有 tsconfig 的 Astro 工程，正常参与类型检查与 lint；
      // 只有它的 .astro 模板与 .mjs 脚本不在 TS project 里（.mjs 已在上条覆盖）。
      "apps/site/**/*.astro",
      // apps/site/public 是原样拷贝到产物的静态资源（含手写的 analytics.js）。
      // 它不在 TS project 里，按浏览器全局写，跑类型感知规则只会刷 no-unsafe-*；
      // 行为由 tests/analytics.test.ts 用 vm 跑真实文件来保证。
      "apps/site/public/**",
      "apps/mobile/src/pwa/**",
      "apps/print-agent/src/**",
      // Rust/Tauri 构建产物（已 gitignore），里面是打包后的 JS，不是源码。
      "apps/print-agent/src-tauri/target/**",
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
    // 铁律 #0：apps/api/src 全目录默认禁止直连数据库，只白名单 kernel / platform。
    // kernel 是业务表唯一写入者；platform 持有连接池、迁移与控制面句柄。
    // 其余目录（http / gateway / shares / onboarding / dev / agent / tools …）
    // 只能通过 kernel service 或 kernel/tenant-scope 拿到租户会话。
    files: ["apps/api/src/**/*.ts"],
    ignores: ["apps/api/src/kernel/**", "apps/api/src/platform/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: DATABASE_PATTERNS,
              message:
                "目录边界铁律：只有 kernel 能写业务表。除组合根外，任何文件都不得 import drizzle-orm / pg / @weave-order/db / platform/database；请通过 kernel service 或 kernel/tenant-scope 访问。",
            },
          ],
        },
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
    files: [
      "apps/api/src/tools/**/*.ts",
      "apps/api/src/approval/**/*.ts",
      "apps/api/src/import/**/*.ts",
      // 凭据层同样不得直连数据库：令牌表只能经 kernel.access 读写。
      "apps/api/src/auth/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: DATABASE_PATTERNS,
              message:
                "目录边界铁律：tools/approval/import 只做编排与解析，禁止直连数据库；写业务表只能经 kernel service。",
            },
          ],
        },
      ],
    },
  },
  {
    // 铁律 #3（第六步补）：http 层只装配 / 注入 kernel、tools、approval，
    // 控制器与上下文文件不得自己开连接，也不得 import drizzle / pg / @weave-order/db。
    files: ["apps/api/src/http/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: DATABASE_PATTERNS,
              message:
                "目录边界铁律：http 层只做请求编排，禁止直连数据库；唯一例外是组合根（http.module.ts / database.provider.ts）的 ../platform/database。",
            },
          ],
        },
      ],
    },
  },
  {
    // 有意的、范围最小的例外：HTTP 组合根持有 DatabaseProvider ——
    // database.provider.ts 建连接，http.module.ts 把它装配进 Nest DI。
    // 只放开 ../platform/database；pg / drizzle-orm / @weave-order/db 依然禁止。
    files: ["apps/api/src/http/http.module.ts", "apps/api/src/http/database.provider.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: COMPOSITION_ROOT_FORBIDDEN,
              message:
                "目录边界铁律：HTTP 组合根只能使用 platform 暴露的连接句柄，禁止直接 import pg / drizzle-orm / @weave-order/db。",
            },
          ],
        },
      ],
    },
  },
);
