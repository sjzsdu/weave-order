/**
 * 迁移纪律守卫（WAN-98）：**已合并的迁移文件与 journal 不可改写**。
 *
 * 用法：
 *   pnpm --filter @weave-order/db migrate:guard -- <base-ref>   # 例如 origin/main
 *   pnpm --filter @weave-order/db migrate:guard -- skip          # 没有可用基线时跳过
 *
 * 判定（基线 → 当前工作区）：
 *   1. 基线里已存在的 `packages/db/drizzle/**` 文件，内容必须逐字节一致；
 *      被删除或被改写都算违纪——需要变更就 `pnpm db:generate` 新增一个迁移。
 *   2. `meta/_journal.json` 中基线已有的条目，`tag` / `when` / `idx` 不得变化
 *      （`when` 一变，drizzle 就会重放它之后的迁移——这正是存量库卡死的根因）。
 *   3. 新增迁移文件与新增 journal 条目是允许且鼓励的做法。
 *
 * 退出码：0 = 通过（或显式 skip）；1 = 发现违纪；2 = 用法错误。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const DRIZZLE_DIR = "packages/db/drizzle";

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

function gitOutput(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, stdout: `${result.stderr ?? ""}${result.stdout ?? ""}`.trim() };
  }
  return { ok: true, stdout: result.stdout };
}

function gitDiffers(baseRef: string, file: string): boolean | null {
  const result = spawnSync("git", ["diff", "--quiet", baseRef, "--", file], { encoding: "utf8" });
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  return null;
}

function readJournal(source: string): JournalEntry[] | null {
  let raw: string;
  if (source.includes(":")) {
    const shown = gitOutput(["show", source]);
    if (!shown.ok) return null;
    raw = shown.stdout;
  } else if (existsSync(source)) {
    raw = readFileSync(source, "utf8");
  } else {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { entries?: JournalEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : null;
  } catch {
    return null;
  }
}

function main(): number {
  // pnpm 会把 `--` 原样透传进来：`migrate:guard -- origin/main` 与 `migrate:guard origin/main` 等价。
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const baseRef = args[0];
  if (!baseRef) {
    console.error("用法：migrate:guard <base-ref> | skip（例如 origin/main）");
    return 2;
  }
  if (baseRef === "skip") {
    console.log("⏭ 未提供可用基线，跳过迁移纪律守卫（本次不校验）。");
    return 0;
  }

  // pnpm --filter 会以包目录为 cwd 运行本脚本：先回到仓库根，保证相对路径与 pathspec 一致。
  const toplevel = gitOutput(["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) {
    console.error("✖ 不在 git 仓库内，无法执行迁移纪律守卫。");
    return 1;
  }
  process.chdir(toplevel.stdout.trim());

  const baseCommit = gitOutput(["rev-parse", "--verify", `${baseRef}^{commit}`]);
  if (!baseCommit.ok) {
    console.error(
      `✖ 无法解析基线 ${baseRef}（需要完整历史：git fetch，或 CI 里 actions/checkout 设 fetch-depth: 0）。`,
    );
    return 1;
  }

  const baseFiles = gitOutput(["ls-tree", "-r", "--name-only", baseRef, "--", DRIZZLE_DIR]);
  if (!baseFiles.ok) {
    console.error(`✖ 无法读取基线 ${baseRef} 的 ${DRIZZLE_DIR} 文件列表。`);
    return 1;
  }
  const basePaths = baseFiles.stdout.split("\n").filter((line) => line.length > 0);

  const violations: string[] = [];
  const added: string[] = [];
  for (const file of basePaths) {
    // _journal.json 是追加式文件（新增条目必然改变字节），由下方 journal 专项检查把关。
    if (file === `${DRIZZLE_DIR}/meta/_journal.json`) continue;
    if (!existsSync(file)) {
      violations.push(`删除了已合并的迁移文件：${file}`);
      continue;
    }
    const differs = gitDiffers(baseRef, file);
    if (differs === null) {
      violations.push(`无法与基线比较（git diff 失败）：${file}`);
    } else if (differs) {
      violations.push(`改写了已合并的迁移文件：${file}`);
    }
  }

  const worktreeFiles = gitOutput(["ls-files", "--", DRIZZLE_DIR]);
  const worktreePaths = new Set(
    worktreeFiles.stdout.split("\n").filter((line) => line.length > 0),
  );
  for (const file of worktreePaths) {
    if (!basePaths.includes(file)) added.push(file);
  }

  const baseJournal = readJournal(`${baseRef}:${DRIZZLE_DIR}/meta/_journal.json`);
  const headJournal = readJournal(`${DRIZZLE_DIR}/meta/_journal.json`);
  if (baseJournal === null || headJournal === null) {
    violations.push(`无法读取 journal（基线或工作区的 ${DRIZZLE_DIR}/meta/_journal.json 缺失/损坏）。`);
  } else {
    for (const baseEntry of baseJournal) {
      const headEntry = headJournal.find((candidate) => candidate.tag === baseEntry.tag);
      if (!headEntry) {
        violations.push(`journal 条目被删除：${baseEntry.tag}`);
        continue;
      }
      if (headEntry.when !== baseEntry.when) {
        violations.push(
          `journal when 被改写：${baseEntry.tag} ${baseEntry.when} → ${headEntry.when}` +
            "（会让 drizzle 重放该迁移及其后续迁移）",
        );
      }
      if (headEntry.idx !== baseEntry.idx) {
        violations.push(`journal 顺序被改写：${baseEntry.tag} idx ${baseEntry.idx} → ${headEntry.idx}`);
      }
    }
    // 追加序：已合并条目必须原样占据头部、顺序不变；新条目只能追加在末尾。
    const baseTags = baseJournal.map((entry) => entry.tag);
    const headPrefix = headJournal.slice(0, baseTags.length).map((entry) => entry.tag);
    if (JSON.stringify(headPrefix) !== JSON.stringify(baseTags)) {
      violations.push(
        "journal 追加序被改写：已合并条目必须原样保留在头部，新条目只能追加在末尾" +
          "（插入中间会让 drizzle 的重放判定错乱）。",
      );
    }
    // when 必须严格递增：否则 when <= max(created_at) 的迁移会被 drizzle 永久静默跳过。
    for (let index = 1; index < headJournal.length; index += 1) {
      const previous = headJournal[index - 1];
      const current = headJournal[index];
      if (previous && current && current.when <= previous.when) {
        violations.push(
          `journal when 非递增：${current.tag}（${current.when}）<= ${previous.tag}（${previous.when}）` +
            "——该迁移及之后的判定会被永久跳过。",
        );
      }
    }
  }

  if (violations.length > 0) {
    console.error("✖ 迁移纪律守卫未通过：已合并的迁移不可改写，需要变更就新增迁移。");
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error("  纪律说明见 docs/development-guide.md「数据库迁移纪律」与 packages/db/README.md。");
    return 1;
  }

  console.log(
    `✔ 迁移纪律守卫通过（基线 ${baseRef}：${basePaths.length} 个文件未被改写，` +
      `新增 ${added.length} 个文件${added.length > 0 ? `：${added.join("、")}` : ""}）。`,
  );
  return 0;
}

process.exitCode = main();
