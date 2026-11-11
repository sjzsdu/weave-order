import path from "node:path";
import { ESLint, Linter } from "eslint";
import { describe, expect, it } from "vitest";

// apps/api/test → 仓库根目录（api 以 CommonJS 编译，用 __dirname 而非 import.meta）。
const rootDir = path.resolve(__dirname, "../../..");
const configPath = path.join(rootDir, "eslint.config.mjs");

type RulesConfig = NonNullable<Linter.Config["rules"]>;
type RuleEntry = RulesConfig[string];

/** 用仓库真实 eslint.config.mjs 解析某个（虚拟）文件路径最终生效的 rules。 */
async function resolvedRules(relativeFilePath: string): Promise<RulesConfig> {
  const eslint = new ESLint({ overrideConfigFile: configPath, cwd: rootDir });
  const config = (await eslint.calculateConfigForFile(
    path.join(rootDir, relativeFilePath),
  )) as Linter.Config;
  return config.rules ?? {};
}

function restrictedRuleIds(filename: string, code: string, ruleConfig: RuleEntry | undefined) {
  const linter = new Linter();
  const rules: RulesConfig = {};
  if (ruleConfig !== undefined) rules["no-restricted-imports"] = ruleConfig;
  const messages = linter.verify(
    code,
    [
      {
        files: ["**/*.ts"],
        languageOptions: { parserOptions: { ecmaVersion: 2022, sourceType: "module" } },
        rules,
      },
    ],
    { filename },
  );
  return messages.filter((m) => m.severity === 2).map((m) => m.ruleId);
}

async function agentRule(): Promise<RuleEntry | undefined> {
  return (await resolvedRules("apps/api/src/agent/foo.ts"))["no-restricted-imports"];
}

async function toolsRule(): Promise<RuleEntry | undefined> {
  return (await resolvedRules("apps/api/src/tools/foo.ts"))["no-restricted-imports"];
}

describe("agent→kernel / 数据库 目录边界（no-restricted-imports）", () => {
  it("规则只作用于 agent / tools，kernel 与其余包不生效（files 作用域）", async () => {
    const agentRules = await resolvedRules("apps/api/src/agent/foo.ts");
    const toolsRules = await resolvedRules("apps/api/src/tools/foo.ts");
    const kernelRules = await resolvedRules("apps/api/src/kernel/foo.ts");
    const schemaRules = await resolvedRules("packages/schema/src/index.ts");

    expect(agentRules["no-restricted-imports"]).toBeDefined();
    expect(toolsRules["no-restricted-imports"]).toBeDefined();
    expect(kernelRules["no-restricted-imports"]).toBeUndefined();
    expect(schemaRules["no-restricted-imports"]).toBeUndefined();
  });

  it("agent 裸 barrel 导入 ../kernel 被拦", async () => {
    expect(
      restrictedRuleIds(
        "apps/api/src/agent/foo.ts",
        'import { customerService } from "../kernel";',
        await agentRule(),
      ),
    ).toContain("no-restricted-imports");
  });

  it("agent 深层路径导入 ../kernel/xxx 被拦", async () => {
    expect(
      restrictedRuleIds(
        "apps/api/src/agent/foo.ts",
        'import { customerService } from "../kernel/customer/customer.service";',
        await agentRule(),
      ),
    ).toContain("no-restricted-imports");
  });

  it("agent 直接触达数据库（drizzle-orm / @weave-order/db / pg）被拦", async () => {
    const rule = await agentRule();
    for (const source of ["drizzle-orm", "@weave-order/db", "pg", "../platform/database"]) {
      expect(
        restrictedRuleIds("apps/api/src/agent/foo.ts", `import x from "${source}";`, rule),
      ).toContain("no-restricted-imports");
    }
  });

  it("tools 可以 import kernel（铁律允许的唯一路径）", async () => {
    const rule = await toolsRule();
    expect(
      restrictedRuleIds("apps/api/src/tools/foo.ts", 'import { x } from "../kernel";', rule),
    ).not.toContain("no-restricted-imports");
  });

  it("tools 绕过内核直连数据库被拦", async () => {
    const rule = await toolsRule();
    for (const source of ["drizzle-orm", "@weave-order/db", "pg"]) {
      expect(
        restrictedRuleIds("apps/api/src/tools/foo.ts", `import x from "${source}";`, rule),
      ).toContain("no-restricted-imports");
    }
  });

  it("非 kernel 路径（../tools）不误伤 agent", async () => {
    expect(
      restrictedRuleIds(
        "apps/api/src/agent/foo.ts",
        'import { tool } from "../tools/t004";',
        await agentRule(),
      ),
    ).not.toContain("no-restricted-imports");
  });
});
