import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * agent skill 的安装：把仓库里的 `skills/weave-order/SKILL.md` 复制到
 * codex / claude 等 agent 会读取的目录。
 *
 * 为什么用文件而不是内嵌：skill 是「给 agent 看的说明书」，它的内容会随
 * 命令面演进；保持仓库里只有一份，避免 CLI 与文档说法不一致。
 */

export interface SkillTarget {
  /** 逻辑目标名，`codex` / `claude` / `generic`。 */
  name: string;
  /** 目标目录（SKILL.md 的父目录）。 */
  dir: string;
}

export function skillSourcePath(): string {
  const override = process.env.WEAVE_SKILL_PATH;
  if (override && existsSync(override)) return override;

  // dist/ 与 src/ 都在 apps/cli 下一层，仓库根目录同样是上三层。
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "skills", "weave-order", "SKILL.md"),
    path.resolve(__dirname, "..", "..", "skills", "weave-order", "SKILL.md"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "找不到 skills/weave-order/SKILL.md：请在 weave-order 仓库内运行，或用 WEAVE_SKILL_PATH 指定路径。",
  );
}

export function resolveSkillTarget(
  target: string | undefined,
  explicitDir: string | undefined,
): SkillTarget {
  if (explicitDir) {
    return { name: "custom", dir: path.resolve(explicitDir) };
  }
  const home = homedir();
  switch ((target ?? "codex").toLowerCase()) {
    case "codex":
      return { name: "codex", dir: path.join(home, ".codex", "skills", "weave-order") };
    case "claude":
      return { name: "claude", dir: path.join(home, ".claude", "skills", "weave-order") };
    case "agents":
    case "generic":
      return { name: "generic", dir: path.join(home, ".weave", "skill") };
    default:
      throw new Error(
        `未知的 skill 目标：${target}（可选 codex / claude / generic，或用 --dir 指定）`,
      );
  }
}

export interface InstallResult {
  source: string;
  file: string;
  changed: boolean;
  bytes: number;
}

export function installSkill(
  target: SkillTarget,
  options: { force?: boolean } = {},
): InstallResult {
  const source = skillSourcePath();
  const content = readFileSync(source, "utf8");
  mkdirSync(target.dir, { recursive: true });
  const file = path.join(target.dir, "SKILL.md");

  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8");
    if (existing === content) {
      return { source, file, changed: false, bytes: Buffer.byteLength(content) };
    }
    if (!options.force) {
      throw new Error(`${file} 已存在且内容不同：确认要覆盖请加 --force（原文件可能被本地改过）。`);
    }
  }

  writeFileSync(file, content, "utf8");
  return { source, file, changed: true, bytes: Buffer.byteLength(content) };
}

export function readSkill(): { path: string; content: string } {
  const source = skillSourcePath();
  return { path: source, content: readFileSync(source, "utf8") };
}
