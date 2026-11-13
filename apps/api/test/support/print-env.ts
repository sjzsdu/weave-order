import type { TestContext } from "vitest";

/**
 * 打印用例的数据库前置断言。
 *
 * 审计发现：缺表时 `ctx.skip()` 会让 5 个打印用例静默不跑，而 `pnpm test` 仍全绿。
 * 现在默认**直接红**，只有显式设置 `PRINT_TEST_SKIP_REASON=<原因>` 才允许跳过，
 * 且跳过原因会写进报告（JSON reporter 里能看到），CI 再断言执行数 > 0。
 */
export const PRINT_TEST_SKIP_REASON = process.env.PRINT_TEST_SKIP_REASON?.trim() || null;

export function requirePrintTestEnv(ctx: Pick<TestContext, "skip">, reason: string): void {
  if (PRINT_TEST_SKIP_REASON) {
    ctx.skip(`显式跳过（PRINT_TEST_SKIP_REASON=${PRINT_TEST_SKIP_REASON}）：${reason}`);
    return;
  }
  throw new Error(
    `[打印测试] ${reason}。打印用例禁止静默跳过：请先 docker compose up -d && pnpm db:migrate；` +
      "确实需要离线运行时，显式设置 PRINT_TEST_SKIP_REASON=<原因>。",
  );
}
