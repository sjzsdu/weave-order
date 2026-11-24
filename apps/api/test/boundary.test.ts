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

async function approvalRule(): Promise<RuleEntry | undefined> {
  return (await resolvedRules("apps/api/src/approval/foo.ts"))["no-restricted-imports"];
}

async function importRule(): Promise<RuleEntry | undefined> {
  return (await resolvedRules("apps/api/src/import/parse.ts"))["no-restricted-imports"];
}

async function authRule(): Promise<RuleEntry | undefined> {
  return (await resolvedRules("apps/api/src/auth/personal-access.service.ts"))[
    "no-restricted-imports"
  ];
}

async function directRule(file: string): Promise<RuleEntry | undefined> {
  return (await resolvedRules(file))["no-restricted-imports"];
}

async function httpRule(): Promise<RuleEntry | undefined> {
  return (await resolvedRules("apps/api/src/http/controllers.ts"))["no-restricted-imports"];
}

async function httpCompositionRootRule(file: string): Promise<RuleEntry | undefined> {
  return (await resolvedRules(`apps/api/src/http/${file}`))["no-restricted-imports"];
}

describe("agent→kernel / 数据库 目录边界（no-restricted-imports）", () => {
  it("唯一写者：apps/api/src 全目录受数据库禁令约束，只白名单 kernel / platform", async () => {
    // 每个业务目录都要有默认禁令，而不是只挑 6 个目录覆盖。
    for (const file of [
      "apps/api/src/agent/foo.ts",
      "apps/api/src/tools/foo.ts",
      "apps/api/src/approval/foo.ts",
      "apps/api/src/import/parse.ts",
      "apps/api/src/http/controllers.ts",
      "apps/api/src/auth/personal-access.service.ts",
      "apps/api/src/gateway/auth.service.ts",
      "apps/api/src/shares/public-share.service.ts",
      "apps/api/src/onboarding/onboarding.service.ts",
      "apps/api/src/dev/personas.controller.ts",
      "apps/api/src/media/media.service.ts",
    ]) {
      expect(await directRule(file), file).toBeDefined();
    }
    // kernel 是业务表唯一写入者（打印中心已并入 kernel/print），platform 持有连接；
    // 两者是白名单，其余包不受影响。
    for (const file of [
      "apps/api/src/kernel/foo.ts",
      "apps/api/src/kernel/print/print-jobs.service.ts",
      "apps/api/src/kernel/demo-identity.ts",
      "apps/api/src/kernel/public-sample-card.service.ts",
      "apps/api/src/platform/database.ts",
      "packages/schema/src/index.ts",
    ]) {
      expect(await directRule(file), file).toBeUndefined();
    }
  });

  it("非内核目录（gateway / shares / dev / onboarding / media）直连数据库被拦，调用 kernel 放行", async () => {
    for (const file of [
      "apps/api/src/gateway/auth.service.ts",
      "apps/api/src/shares/public-share.service.ts",
      "apps/api/src/dev/personas.controller.ts",
      "apps/api/src/onboarding/onboarding.service.ts",
      "apps/api/src/media/media.service.ts",
    ]) {
      const rule = await directRule(file);
      for (const source of ["drizzle-orm", "@weave-order/db", "pg", "../platform/database"]) {
        expect(restrictedRuleIds(file, `import x from "${source}";`, rule)).toContain(
          "no-restricted-imports",
        );
      }
      expect(
        restrictedRuleIds(file, 'import { createKernel } from "../kernel";', rule),
      ).not.toContain("no-restricted-imports");
    }
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

  it("approval 绕过内核直连数据库被拦，调用 kernel 放行（铁律）", async () => {
    const rule = await approvalRule();
    for (const source of ["drizzle-orm", "@weave-order/db", "pg", "../platform/database"]) {
      expect(
        restrictedRuleIds("apps/api/src/approval/foo.ts", `import x from "${source}";`, rule),
      ).toContain("no-restricted-imports");
    }
    expect(
      restrictedRuleIds("apps/api/src/approval/foo.ts", 'import { x } from "../kernel";', rule),
    ).not.toContain("no-restricted-imports");
  });

  it("import 适配器绕过内核直连数据库被拦（第六步）", async () => {
    const rule = await importRule();
    for (const source of ["drizzle-orm", "@weave-order/db", "pg", "../platform/database"]) {
      expect(
        restrictedRuleIds("apps/api/src/import/parse.ts", `import x from "${source}";`, rule),
      ).toContain("no-restricted-imports");
    }
  });

  it("http 控制器直连数据库被拦（第六步补）", async () => {
    const rule = await httpRule();
    for (const file of ["apps/api/src/http/controllers.ts", "apps/api/src/http/context.ts"]) {
      for (const source of ["drizzle-orm", "@weave-order/db", "pg", "../platform/database"]) {
        expect(restrictedRuleIds(file, `import x from "${source}";`, rule)).toContain(
          "no-restricted-imports",
        );
      }
    }
  });

  it("http 组合根只放开 ../platform/database，pg / drizzle-orm / @weave-order/db 仍被拦", async () => {
    for (const file of ["http.module.ts", "database.provider.ts"]) {
      const rule = await httpCompositionRootRule(file);
      expect(rule).toBeDefined();
      expect(
        restrictedRuleIds(
          `apps/api/src/http/${file}`,
          'import { connectDatabase } from "../platform/database";',
          rule,
        ),
      ).not.toContain("no-restricted-imports");
      for (const source of ["pg", "drizzle-orm", "@weave-order/db"]) {
        expect(
          restrictedRuleIds(`apps/api/src/http/${file}`, `import x from "${source}";`, rule),
        ).toContain("no-restricted-imports");
      }
    }
  });

  it("凭据层绕过 kernel.access 直连数据库被拦（WAN-78）", async () => {
    const rule = await authRule();
    for (const source of ["drizzle-orm", "@weave-order/db", "pg"]) {
      expect(
        restrictedRuleIds(
          "apps/api/src/auth/personal-access.service.ts",
          `import x from "${source}";`,
          rule,
        ),
      ).toContain("no-restricted-imports");
    }
    expect(
      restrictedRuleIds(
        "apps/api/src/auth/personal-access.service.ts",
        'import { createKernel } from "../kernel";',
        rule,
      ),
    ).not.toContain("no-restricted-imports");
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
