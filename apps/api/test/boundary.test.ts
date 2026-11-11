import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint, Linter } from "eslint";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const configPath = path.join(rootDir, "eslint.config.mjs");

/** 用仓库真实 eslint.config.mjs 解析某个（虚拟）文件路径最终生效的 rules。 */
async function resolvedRules(relativeFilePath: string) {
  const eslint = new ESLint({ overrideConfigFile: configPath, cwd: rootDir });
  const config = await eslint.calculateConfigForFile(path.join(rootDir, relativeFilePath));
  return config.rules ?? {};
}

/** 用 Linter（非 type-aware）对一段源码跑 no-restricted-imports 规则，返回命中的规则名。 */
function restrictedRuleIds(code: string, ruleConfig: unknown) {
  const linter = new Linter();
  const messages = linter.verify(
    code,
    [
      {
        files: ["**/*.ts"],
        languageOptions: { parserOptions: { ecmaVersion: 2022, sourceType: "module" } },
        rules: { "no-restricted-imports": ruleConfig },
      },
    ],
    { filename: "apps/api/src/agent/foo.ts" },
  );
  return messages.filter((m) => m.severity === 2).map((m) => m.ruleId);
}

describe("agent→kernel 目录边界（no-restricted-imports）", () => {
  it("规则只作用于 agent，tools / 其余包不生效（files 作用域）", async () => {
    const agentRules = await resolvedRules("apps/api/src/agent/foo.ts");
    const toolsRules = await resolvedRules("apps/api/src/tools/foo.ts");
    const schemaRules = await resolvedRules("packages/schema/src/index.ts");

    expect(agentRules["no-restricted-imports"]).toBeDefined();
    expect(toolsRules["no-restricted-imports"]).toBeUndefined();
    expect(schemaRules["no-restricted-imports"]).toBeUndefined();
  });

  it("agent 裸 barrel 导入 ../kernel 被拦", async () => {
    const rule = (await resolvedRules("apps/api/src/agent/foo.ts"))["no-restricted-imports"];
    expect(restrictedRuleIds('import { customerService } from "../kernel";', rule)).toContain(
      "no-restricted-imports",
    );
  });

  it("agent 深层路径导入 ../kernel/xxx 被拦", async () => {
    const rule = (await resolvedRules("apps/api/src/agent/foo.ts"))["no-restricted-imports"];
    expect(
      restrictedRuleIds(
        'import { customerService } from "../kernel/customer/customer.service";',
        rule,
      ),
    ).toContain("no-restricted-imports");
  });

  it("非 kernel 路径（../tools）不误伤", async () => {
    const rule = (await resolvedRules("apps/api/src/agent/foo.ts"))["no-restricted-imports"];
    expect(restrictedRuleIds('import { tool } from "../tools/t004";', rule)).not.toContain(
      "no-restricted-imports",
    );
  });
});
