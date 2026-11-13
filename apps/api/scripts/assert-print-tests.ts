/**
 * CI 守卫：打印用例必须真的跑过。
 *
 * `vitest run --outputFile.json=...` 会写出每个测试文件的断言结果；
 * 这里断言 print.* 用例「执行数 > 0 且没有 skip」——只有 `ctx.skip()`
 * 被换成显式失败还不够：文件被过滤掉 / 收集不到时同样是假绿。
 *
 * 用法：tsx scripts/assert-print-tests.ts test-results/vitest.json
 */
import { readFileSync } from "node:fs";
import path from "node:path";

interface AssertionResult {
  status?: string;
  fullName?: string;
}

interface TestResult {
  name?: string;
  assertionResults?: AssertionResult[];
}

interface VitestJson {
  testResults?: TestResult[];
}

function fail(message: string): never {
  console.error(`[print-test-guard] ${message}`);
  process.exit(1);
}

const reportPath = process.argv[2] ?? "test-results/vitest.json";
let report: VitestJson;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8")) as VitestJson;
} catch (error) {
  fail(
    `读不到测试报告 ${reportPath}（${error instanceof Error ? error.message : String(error)}）。` +
      "请先运行 pnpm test（会生成 --outputFile.json 报告）。",
  );
}

const printFiles = (report.testResults ?? []).filter((result) => {
  const base = path.basename(String(result.name ?? ""));
  return base.startsWith("print.") && base.endsWith(".test.ts");
});

if (printFiles.length === 0) {
  fail("测试报告里没有任何 print.* 用例：打印链路实际未被验证。");
}

const executed = (result: TestResult) =>
  (result.assertionResults ?? []).filter(
    (assertion) => assertion.status === "passed" || assertion.status === "failed",
  ).length;
const skipped = (result: TestResult) =>
  (result.assertionResults ?? []).filter((assertion) =>
    ["pending", "skipped", "todo"].includes(String(assertion.status)),
  ).length;

// 逐文件汇总，报告里能看到「哪个文件没跑」。
for (const result of printFiles) {
  console.log(
    `[print-test-guard] ${path.basename(String(result.name))}: ` +
      `${executed(result)} executed, ${skipped(result)} skipped`,
  );
}

const totalExecuted = printFiles.reduce((sum, result) => sum + executed(result), 0);
const totalSkipped = printFiles.reduce((sum, result) => sum + skipped(result), 0);

if (totalExecuted === 0) {
  fail("print 用例执行数为 0（全部被跳过或未收集）。");
}
if (totalSkipped > 0) {
  fail(`print 用例有 ${totalSkipped} 条被跳过：打印链路不允许静默 skip。`);
}

// 真连 PG 的两条主链路必须实际执行（重命名/挪走也不能让守卫失去目标）。
for (const required of ["print.integration.test.ts", "print.e2e.test.ts"]) {
  const found = printFiles.find((result) => path.basename(String(result.name ?? "")) === required);
  if (!found) fail(`测试报告里缺少 ${required}：打印主链路没有被执行。`);
  if (executed(found) === 0) fail(`${required} 执行数为 0：打印主链路没有被验证。`);
}

console.log(`[print-test-guard] OK：${totalExecuted} 条 print 用例执行，0 条跳过。`);
