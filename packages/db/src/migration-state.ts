import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

/**
 * 迁移状态体检与对齐（WAN-98）。
 *
 * 机制事实（drizzle-orm 0.45.4 `pg-core/dialect.cjs` 的 `migrate()`）：
 * 是否重放某个迁移，只看 `drizzle.__drizzle_migrations` 中 `created_at` 的最大值与
 * journal 条目 `when` 的大小——`when > max(created_at)` 就按 journal 顺序重放该条及之后的迁移；
 * `hash` 只写入、不参与判定。因此「迁移文件 / journal 的 `when` 在应用之后被改写」
 * 会让 drizzle 重放老迁移，撞上 `type/table already exists`，存量库就此卡死。
 *
 * 本模块做三件事：
 *  1. 逐条解析迁移 SQL 中**可机器核验**的对象断言（表/类型/列/索引/约束/触发器/函数），
 *     按「后写者胜」归属到 journal 条目（0003 DROP 掉 0000 建的索引 → 该索引的存亡由 0003 说了算），
 *     判断每个条目到底是「已应用 / 未应用 / 只应用了一半」；
 *  2. 在不改写任何迁移文件的前提下，把 `drizzle.__drizzle_migrations` 的记录对齐到当前 journal；
 *  3. 处理「水位空洞」：某迁移对象完全缺失、却排在已应用迁移之前（drizzle 永远不会重放它）——
 *     这类迁移只能由本工具在单事务里直接执行（仅限纯 DDL），并生成可执行的回滚语句。
 *
 * 核验覆盖与限制（诚实边界）：
 *  - 逐条核验：CREATE TABLE / TYPE / INDEX / CONSTRAINT / TRIGGER / FUNCTION、
 *    ADD|DROP COLUMN、ADD|DROP CONSTRAINT、DROP INDEX；
 *  - 不逐条核验：修饰性 `ALTER COLUMN ...`（SET NOT NULL / 改类型等）、`INSERT INTO`
 *    种子数据、`DO $$` 块——报告中计数提示；含这类语句的迁移**不会**被直接执行（报错交给人）。
 */

const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

export interface MigrationEntry {
  idx: number;
  tag: string;
  when: number;
  /** sha256(迁移文件原文)，与 drizzle-orm 的算法一致（写入记录用，不参与重放判定）。 */
  hash: string;
  statements: string[];
}

export interface MigrationRecord {
  id: number;
  hash: string;
  /** bigint → pg 默认按字符串返回，比较前统一 Number()。 */
  createdAt: number;
}

interface ObjectClaim {
  /** 规范对象键，用于「后写者胜」的归属判定。 */
  key: string;
  /** 展示用标签，例如 `table public.print_jobs` */
  label: string;
  /** true = 对象应当存在；false = 对象应当不存在（DROP 语句） */
  shouldExist: boolean;
  sql: string;
  params: string[];
}

interface StatementAnalysis {
  claims: ObjectClaim[];
  /** 修饰性语句（ALTER COLUMN ... 等）：只计数，不逐条判定。 */
  modifiers: string[];
  /** 无法核验的语句（INSERT / DO 块等）：计数并在报告中提示。 */
  unverifiable: string[];
}

interface OwnedClaim {
  claim: ObjectClaim;
  satisfied: boolean;
}

export type EntryStatus =
  /** 记录存在、对象齐全、时间戳与 journal 一致：drizzle 不会重放，也不需要动。 */
  | { kind: "aligned"; recordId: number }
  /** 记录存在且对象齐全，但 `created_at` 与 journal `when` 不一致：需要改时间戳。 */
  | { kind: "stale-record"; recordId: number; recordedWhen: number }
  /** 没有记录，但对象状态与该迁移的断言一致（迁移文件在应用之后被改写过）：需要补记录。 */
  | { kind: "unrecorded" }
  /** 没有记录，且对象状态与断言不符：还没应用过（能否重放取决于 when）。 */
  | { kind: "not-applied" }
  /** 没有记录，但对象只存在一部分：不能自动对齐，需要人工决定。 */
  | { kind: "partial"; missing: string[] }
  /** 有记录，但库里对象缺失（有人在迁移之后删过对象）：需要人工决定。 */
  | { kind: "drifted"; recordId: number; missing: string[] }
  /** 没有可归属的核验断言（对象已被后续迁移接管，或迁移里只有 INSERT/DO）。 */
  | { kind: "unverifiable"; reason: string };

export interface EntryAnalysis {
  entry: MigrationEntry;
  status: EntryStatus;
  /** 归属本条目、参与判定的断言数。 */
  ownedClaimCount: number;
  /** 被后续迁移接管、不参与判定的断言数。 */
  supersededClaimCount: number;
  modifierCount: number;
  unverifiableCount: number;
  /** 归属本条目且当前满足的断言（用于生成回滚语句）。 */
  ownedClaims: OwnedClaim[];
}

export interface RecordUpdate {
  recordId: number;
  tag: string;
  hash: string;
  from: number;
  to: number;
}

export interface RecordInsert {
  tag: string;
  hash: string;
  when: number;
}

/** 水位空洞：对象完全缺失、却排在已应用水位之前，只能直接执行。 */
export interface BlockedExecution {
  entry: MigrationEntry;
  /** 执行后可用的回滚语句（针对将被创建的对象）。 */
  rollback: string[];
  /** 该迁移会删除的对象（回滚需要人工恢复，报告中提示）。 */
  removed: string[];
}

export interface RepairPlan {
  analyses: EntryAnalysis[];
  updates: RecordUpdate[];
  inserts: RecordInsert[];
  executions: BlockedExecution[];
  /** hash 对不上任何 journal 条目的历史记录（journal 被重排/删改过的化石）。 */
  orphans: MigrationRecord[];
  errors: string[];
  warnings: string[];
  /** 对齐后 drizzle 看到的 max(created_at)，决定哪些迁移还会被重放。 */
  effectiveMax: number;
  /** 对齐后仍会被 drizzle 正常重放的条目（正常情况下只剩「尚未应用」的新增迁移）。 */
  pending: MigrationEntry[];
}

/** 读取 journal + 迁移文件，hash 算法与 drizzle-orm/migrator 保持一致。 */
export function readMigrationEntries(migrationsFolder: string): MigrationEntry[] {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  return journal.entries.map((journalEntry) => {
    const sql = readFileSync(path.join(migrationsFolder, `${journalEntry.tag}.sql`), "utf8");
    return {
      idx: journalEntry.idx,
      tag: journalEntry.tag,
      when: journalEntry.when,
      hash: createHash("sha256").update(sql).digest("hex"),
      statements: sql.split("--> statement-breakpoint"),
    };
  });
}

/** 去掉语句开头的注释行；返回空串表示这条语句没有可执行内容。 */
export function stripLeadingComments(sql: string): string {
  const lines = sql.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("--")) {
      index += 1;
      continue;
    }
    break;
  }
  return lines.slice(index).join("\n").trim();
}

function splitQualified(raw: string): { schema: string; name: string } {
  const cleaned = raw.replace(/"/g, "");
  const dot = cleaned.indexOf(".");
  if (dot === -1) return { schema: "public", name: cleaned };
  return { schema: cleaned.slice(0, dot), name: cleaned.slice(dot + 1) };
}

/** 标识符 token（非捕获）：带引号 `"foo"` 或裸标识符 `foo`（drizzle 两种写法都有）。 */
const QNAME_TOKEN = String.raw`(?:"[^"]+"|[\w$]+)`;
/** 单个标识符捕获组：用于一条语句里还要再捕获第二个名字的规则（索引名/列名/约束名/触发器名）。 */
const QNAME = String.raw`(${QNAME_TOKEN})`;
/** 可选 schema 前缀的限定名（单个捕获组）：`"public"."foo"` / `public.foo` / `foo`。 */
const QUALIFIED = String.raw`((?:${QNAME_TOKEN}\.)?${QNAME_TOKEN})`;

const SQL_EXISTS = {
  type: {
    sql: "SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2",
    parts: 2,
  },
  table: {
    sql: "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'",
    parts: 2,
  },
  index: {
    sql: "SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2",
    parts: 2,
  },
  column: {
    sql: "SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3",
    parts: 3,
  },
  constraint: {
    sql: "SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid JOIN pg_namespace n ON n.oid = rel.relnamespace WHERE n.nspname = $1 AND rel.relname = $2 AND c.conname = $3",
    parts: 3,
  },
  trigger: {
    sql: "SELECT 1 FROM pg_trigger t JOIN pg_class rel ON rel.oid = t.tgrelid JOIN pg_namespace n ON n.oid = rel.relnamespace WHERE n.nspname = $1 AND rel.relname = $2 AND t.tgname = $3 AND NOT t.tgisinternal",
    parts: 3,
  },
  function: {
    sql: "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2",
    parts: 2,
  },
} as const;

type ClaimKind = keyof typeof SQL_EXISTS;

function claim(
  kind: ClaimKind,
  key: string,
  label: string,
  shouldExist: boolean,
  params: string[],
): ObjectClaim {
  const spec = SQL_EXISTS[kind];
  if (spec.parts !== params.length) {
    throw new Error(`内部错误：${kind} 断言需要 ${spec.parts} 个参数，实得 ${params.length}`);
  }
  return { key, label, shouldExist, sql: spec.sql, params };
}

interface Rule {
  re: RegExp;
  build: (match: RegExpMatchArray) => ObjectClaim;
}

/** drizzle 生成的 SQL 高度规整，按语句开头匹配即可，不需要完整 SQL 解析。 */
const RULES: Rule[] = [
  {
    re: new RegExp(
      String.raw`^CREATE\s+TYPE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}\s+AS\s+ENUM\b`,
      "i",
    ),
    build: (m) => {
      const { schema, name } = splitQualified(m[1] ?? "");
      return claim("type", `type:${schema}.${name}`, `type ${schema}.${name}`, true, [schema, name]);
    },
  },
  {
    re: new RegExp(
      String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}\s*\(`,
      "i",
    ),
    build: (m) => {
      const { schema, name } = splitQualified(m[1] ?? "");
      return claim(
        "table",
        `table:${schema}.${name}`,
        `table ${schema}.${name}`,
        true,
        [schema, name],
      );
    },
  },
  {
    re: new RegExp(
      String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${QNAME}\s+ON\s+${QUALIFIED}`,
      "i",
    ),
    build: (m) => {
      const indexName = splitQualified(m[1] ?? "").name;
      const { schema } = splitQualified(m[2] ?? "");
      return claim(
        "index",
        `index:${schema}.${indexName}`,
        `index ${schema}.${indexName}`,
        true,
        [schema, indexName],
      );
    },
  },
  {
    re: new RegExp(String.raw`^DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?${QUALIFIED}`, "i"),
    build: (m) => {
      const { schema, name } = splitQualified(m[1] ?? "");
      return claim(
        "index",
        `index:${schema}.${name}`,
        `index ${schema}.${name}（应已删除）`,
        false,
        [schema, name],
      );
    },
  },
  {
    re: new RegExp(
      String.raw`^ALTER\s+TABLE\s+${QUALIFIED}\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?${QNAME}`,
      "i",
    ),
    build: (m) => {
      const table = splitQualified(m[1] ?? "");
      const column = splitQualified(m[2] ?? "").name;
      return claim(
        "column",
        `column:${table.schema}.${table.name}.${column}`,
        `column ${table.schema}.${table.name}.${column}`,
        true,
        [table.schema, table.name, column],
      );
    },
  },
  {
    re: new RegExp(
      String.raw`^ALTER\s+TABLE\s+${QUALIFIED}\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?${QNAME}`,
      "i",
    ),
    build: (m) => {
      const table = splitQualified(m[1] ?? "");
      const column = splitQualified(m[2] ?? "").name;
      return claim(
        "column",
        `column:${table.schema}.${table.name}.${column}`,
        `column ${table.schema}.${table.name}.${column}（应已删除）`,
        false,
        [table.schema, table.name, column],
      );
    },
  },
  {
    re: new RegExp(
      String.raw`^ALTER\s+TABLE\s+${QUALIFIED}\s+ADD\s+CONSTRAINT\s+${QNAME}`,
      "i",
    ),
    build: (m) => {
      const table = splitQualified(m[1] ?? "");
      const constraint = splitQualified(m[2] ?? "").name;
      return claim(
        "constraint",
        `constraint:${table.schema}.${table.name}.${constraint}`,
        `constraint ${table.schema}.${table.name}.${constraint}`,
        true,
        [table.schema, table.name, constraint],
      );
    },
  },
  {
    re: new RegExp(
      String.raw`^ALTER\s+TABLE\s+${QUALIFIED}\s+DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?${QNAME}`,
      "i",
    ),
    build: (m) => {
      const table = splitQualified(m[1] ?? "");
      const constraint = splitQualified(m[2] ?? "").name;
      return claim(
        "constraint",
        `constraint:${table.schema}.${table.name}.${constraint}`,
        `constraint ${table.schema}.${table.name}.${constraint}（应已删除）`,
        false,
        [table.schema, table.name, constraint],
      );
    },
  },
  {
    re: new RegExp(
      String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+${QNAME}[\s\S]*?\sON\s+${QUALIFIED}`,
      "i",
    ),
    build: (m) => {
      const trigger = splitQualified(m[1] ?? "").name;
      const table = splitQualified(m[2] ?? "");
      return claim(
        "trigger",
        `trigger:${table.schema}.${table.name}.${trigger}`,
        `trigger ${table.schema}.${table.name}.${trigger}`,
        true,
        [table.schema, table.name, trigger],
      );
    },
  },
  {
    re: new RegExp(
      String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${QUALIFIED}`,
      "i",
    ),
    build: (m) => {
      const { schema, name } = splitQualified(m[1] ?? "");
      return claim(
        "function",
        `function:${schema}.${name}`,
        `function ${schema}.${name}`,
        true,
        [schema, name],
      );
    },
  },
];

function firstLine(statement: string): string {
  const line = statement.split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** 解析单条语句：能核验的产出断言，其余归入 modifier / unverifiable。 */
export function analyzeStatement(raw: string): StatementAnalysis {
  const statement = stripLeadingComments(raw);
  if (statement === "") {
    return { claims: [], modifiers: [], unverifiable: [] };
  }
  for (const rule of RULES) {
    const match = statement.match(rule.re);
    if (match) {
      return { claims: [rule.build(match)], modifiers: [], unverifiable: [] };
    }
  }
  if (/^ALTER\s+TABLE\s+/i.test(statement)) {
    return { claims: [], modifiers: [firstLine(statement)], unverifiable: [] };
  }
  return { claims: [], modifiers: [], unverifiable: [firstLine(statement)] };
}

export async function readMigrationRecords(pool: Pool): Promise<MigrationRecord[]> {
  const result = await pool.query<{ id: number; hash: string; created_at: string }>(
    `SELECT id, hash, created_at FROM ${MIGRATIONS_SCHEMA}."${MIGRATIONS_TABLE}" ORDER BY id`,
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    hash: row.hash,
    createdAt: Number(row.created_at),
  }));
}

export async function migrationsTableExists(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [`${MIGRATIONS_SCHEMA}."${MIGRATIONS_TABLE}"`],
  );
  return result.rows[0]?.exists === true;
}

async function claimSatisfied(pool: Pool, objectClaim: ObjectClaim): Promise<boolean> {
  const result = await pool.query(objectClaim.sql, objectClaim.params);
  const found = Number(result.rowCount ?? 0) > 0;
  return objectClaim.shouldExist ? found : !found;
}

interface ParsedEntry {
  entry: MigrationEntry;
  claims: ObjectClaim[];
  modifiers: string[];
  unverifiable: string[];
}

function parseEntries(entries: MigrationEntry[]): ParsedEntry[] {
  return entries.map((entry) => {
    const claims: ObjectClaim[] = [];
    const modifiers: string[] = [];
    const unverifiable: string[] = [];
    for (const statement of entry.statements) {
      const analysis = analyzeStatement(statement);
      claims.push(...analysis.claims);
      modifiers.push(...analysis.modifiers);
      unverifiable.push(...analysis.unverifiable);
    }
    return { entry, claims, modifiers, unverifiable };
  });
}

/**
 * 逐条核验每个 journal 条目的对象状态与记录状态。
 * 断言按「后写者胜」归属：同一个对象被后面的迁移改过存亡，就由后面那条说了算，
 * 前面那条的断言不再参与判定（否则 0000 会被 0003 的 DROP 误判成「对象缺失」）。
 */
export async function analyzeEntries(
  pool: Pool,
  entries: MigrationEntry[],
  records: MigrationRecord[],
): Promise<EntryAnalysis[]> {
  const parsed = parseEntries(entries);

  // 归属：journal 顺序里最后一个断言该对象的条目拥有它。
  const ownerByKey = new Map<string, number>();
  parsed.forEach((item, entryIndex) => {
    for (const objectClaim of item.claims) {
      ownerByKey.set(objectClaim.key, entryIndex);
    }
  });

  const analyses: EntryAnalysis[] = [];
  for (const [entryIndex, item] of parsed.entries()) {
    const owned: ObjectClaim[] = [];
    let superseded = 0;
    for (const objectClaim of item.claims) {
      if (ownerByKey.get(objectClaim.key) === entryIndex) {
        owned.push(objectClaim);
      } else {
        superseded += 1;
      }
    }

    const ownedClaims: OwnedClaim[] = [];
    for (const objectClaim of owned) {
      ownedClaims.push({ claim: objectClaim, satisfied: await claimSatisfied(pool, objectClaim) });
    }

    const record = records.find((candidate) => candidate.hash === item.entry.hash);
    const missing = ownedClaims
      .filter((ownedClaim) => !ownedClaim.satisfied)
      .map((ownedClaim) => ownedClaim.claim.label);

    let status: EntryStatus;
    if (record) {
      if (missing.length > 0) {
        status = { kind: "drifted", recordId: record.id, missing };
      } else if (record.createdAt !== item.entry.when) {
        status = {
          kind: "stale-record",
          recordId: record.id,
          recordedWhen: record.createdAt,
        };
      } else {
        status = { kind: "aligned", recordId: record.id };
      }
    } else if (owned.length === 0) {
      status = {
        kind: "unverifiable",
        reason: superseded > 0 ? "对象存亡已由后续迁移接管" : "迁移中没有可核验的对象",
      };
    } else {
      const creations = ownedClaims.filter((ownedClaim) => ownedClaim.claim.shouldExist);
      const removals = ownedClaims.filter((ownedClaim) => !ownedClaim.claim.shouldExist);
      const creationsHeld = creations.filter((ownedClaim) => ownedClaim.satisfied).length;
      const removalsHeld = removals.filter((ownedClaim) => ownedClaim.satisfied).length;
      if (creations.length === 0) {
        // 只有删除类断言：全部满足 = 效果成立（补记录）；否则 = 没应用过。
        status = removalsHeld === removals.length ? { kind: "unrecorded" } : { kind: "not-applied" };
      } else if (creationsHeld === creations.length && removalsHeld === removals.length) {
        status = { kind: "unrecorded" };
      } else if (creationsHeld === 0) {
        // 该迁移创建的对象一个都不在：没应用过（删除类断言是否满足不改变这个结论）。
        status = { kind: "not-applied" };
      } else {
        status = { kind: "partial", missing };
      }
    }

    analyses.push({
      entry: item.entry,
      status,
      ownedClaimCount: owned.length,
      supersededClaimCount: superseded,
      modifierCount: item.modifiers.length,
      unverifiableCount: item.unverifiable.length,
      ownedClaims,
    });
  }
  return analyses;
}

function rollbackFor(ownedClaim: OwnedClaim): string | null {
  const { claim: objectClaim, satisfied } = ownedClaim;
  if (!objectClaim.shouldExist || satisfied) return null;
  const [first, second, third] = objectClaim.params;
  switch (objectClaim.key.split(":")[0]) {
    case "table":
      return `DROP TABLE "${first}"."${second}" CASCADE;  -- ${objectClaim.label}`;
    case "type":
      return `DROP TYPE "${first}"."${second}" CASCADE;  -- ${objectClaim.label}`;
    case "index":
      return `DROP INDEX "${first}"."${second}";  -- ${objectClaim.label}`;
    case "column":
      return `ALTER TABLE "${first}"."${second}" DROP COLUMN "${third}";  -- ${objectClaim.label}`;
    case "constraint":
      return `ALTER TABLE "${first}"."${second}" DROP CONSTRAINT "${third}";  -- ${objectClaim.label}`;
    case "trigger":
      return `DROP TRIGGER "${third}" ON "${first}"."${second}";  -- ${objectClaim.label}`;
    case "function":
      return `DROP FUNCTION IF EXISTS "${first}"."${second}";  -- ${objectClaim.label}（若同名重载请手工补参数）`;
    default:
      return null;
  }
}

/** 产出对齐计划：补记录 / 改时间戳 / 直接执行被水位挡住的迁移，并把危险状态升级为错误。 */
export function buildPlan(analyses: EntryAnalysis[], records: MigrationRecord[]): RepairPlan {
  const updates: RecordUpdate[] = [];
  const inserts: RecordInsert[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const analysis of analyses) {
    const { entry, status } = analysis;
    switch (status.kind) {
      case "stale-record":
        updates.push({
          recordId: status.recordId,
          tag: entry.tag,
          hash: entry.hash,
          from: status.recordedWhen,
          to: entry.when,
        });
        break;
      case "unrecorded":
        inserts.push({ tag: entry.tag, hash: entry.hash, when: entry.when });
        break;
      case "partial":
        errors.push(
          `${entry.tag}：只应用了一半（缺 ${status.missing.join("、")}）。` +
            "不能自动对齐——请人工确认后新增一个补丁迁移（用 IF NOT EXISTS 幂等补齐），或恢复缺失对象。",
        );
        break;
      case "drifted":
        errors.push(
          `${entry.tag}：记录显示已应用，但库中缺少 ${status.missing.join("、")}。` +
            "对象被迁移之后删改过，需要人工决定（补对象或新增补丁迁移），本工具不会替你掩盖。",
        );
        break;
      case "aligned":
      case "not-applied":
      case "unverifiable":
        break;
    }
    if (analysis.modifierCount > 0 || analysis.unverifiableCount > 0) {
      warnings.push(
        `${entry.tag}：${analysis.modifierCount} 条修饰性语句 + ${analysis.unverifiableCount} 条无法核验的语句` +
          "（不参与判定，仅提示）。",
      );
    }
    if (analysis.supersededClaimCount > 0) {
      warnings.push(
        `${entry.tag}：${analysis.supersededClaimCount} 条断言的存亡已由后续迁移接管，不参与本条判定。`,
      );
    }
  }

  const recordMax = records.reduce((max, record) => Math.max(max, record.createdAt), 0);
  const alignMax = [...updates.map((update) => update.to), ...inserts.map((insert) => insert.when)];
  const effectiveMax = Math.max(recordMax, ...alignMax);

  const pending: MigrationEntry[] = [];
  const executions: BlockedExecution[] = [];
  for (const analysis of analyses) {
    const { entry, status } = analysis;
    if (status.kind === "aligned" || status.kind === "stale-record") continue;
    if (entry.when > effectiveMax) {
      pending.push(entry);
      if (status.kind === "unverifiable") {
        warnings.push(
          `${entry.tag}：没有可核验的对象且无记录，将被重放；若它其实已应用过且不可重放，需人工核对。`,
        );
      }
      continue;
    }
    if (status.kind === "not-applied") {
      if (analysis.unverifiableCount > 0) {
        errors.push(
          `${entry.tag}：对象缺失、排在已应用水位（${effectiveMax}）之前，drizzle 不会重放它；` +
            `但它含 ${analysis.unverifiableCount} 条无法核验的语句（INSERT/DO 等），` +
            "不能由修复脚本直接执行——请人工执行该迁移的 SQL 或新增幂等补丁迁移。",
        );
        continue;
      }
      const rollback: string[] = [];
      const removed: string[] = [];
      for (const ownedClaim of analysis.ownedClaims) {
        const statement = rollbackFor(ownedClaim);
        if (statement) {
          rollback.push(statement);
        } else if (!ownedClaim.claim.shouldExist && !ownedClaim.satisfied) {
          removed.push(ownedClaim.claim.label);
        }
      }
      executions.push({ entry, rollback, removed });
      continue;
    }
    if (status.kind === "unverifiable") {
      errors.push(
        `${entry.tag}：无记录、无可核验对象，且 when=${entry.when} <= 已应用水位 ${effectiveMax}，` +
          "无法判定是否已应用过，需要人工核对。",
      );
    }
  }

  const entryHashes = new Set(analyses.map((analysis) => analysis.entry.hash));
  const orphans = records.filter((record) => !entryHashes.has(record.hash));
  for (const orphan of orphans) {
    if (pending.some((entry) => entry.when <= orphan.createdAt)) {
      errors.push(
        `孤立记录 id=${orphan.id}（hash=${orphan.hash.slice(0, 12)}，created_at=${orphan.createdAt}）` +
          "时间戳高于待应用迁移，会吞掉它们——需要人工核对该记录来源后再处理。",
      );
    } else {
      warnings.push(
        `孤立记录 id=${orphan.id}（hash=${orphan.hash.slice(0, 12)}…，created_at=${orphan.createdAt}）` +
          "在 journal 中已无对应条目：保留不动，仅作历史痕迹。",
      );
    }
  }

  return {
    analyses,
    updates,
    inserts,
    executions,
    orphans,
    errors,
    warnings,
    effectiveMax,
    pending,
  };
}

function statusText(analysis: EntryAnalysis): string {
  const { entry, status } = analysis;
  switch (status.kind) {
    case "aligned":
      return "✔ 已对齐";
    case "stale-record":
      return `⚠ 记录时间戳漂移：${status.recordedWhen} → 应为 ${entry.when}`;
    case "unrecorded":
      return "⚠ 无记录（对象状态与断言一致，迁移文件被改写过）";
    case "not-applied":
      return "· 未应用";
    case "partial":
      return `✖ 只应用了一半：缺 ${status.missing.join("、")}`;
    case "drifted":
      return `✖ 记录已应用但对象缺失：${status.missing.join("、")}`;
    case "unverifiable":
      return `? 无法核验（${status.reason}）`;
  }
}

function planLines(plan: RepairPlan): { actions: string[]; rollback: string[] } {
  const actions: string[] = [];
  const rollback: string[] = [];
  for (const update of plan.updates) {
    actions.push(
      `UPDATE id=${update.recordId} created_at ${update.from} → ${update.to}（${update.tag}）`,
    );
    rollback.push(
      `UPDATE ${MIGRATIONS_SCHEMA}."${MIGRATIONS_TABLE}" SET created_at = ${update.from} WHERE id = ${update.recordId};  -- ${update.tag}`,
    );
  }
  for (const insert of plan.inserts) {
    actions.push(`INSERT 记录 hash=${insert.hash.slice(0, 12)}… created_at=${insert.when}（${insert.tag}）`);
    rollback.push(
      `DELETE FROM ${MIGRATIONS_SCHEMA}."${MIGRATIONS_TABLE}" WHERE hash = '${insert.hash}' AND created_at = ${insert.when};  -- ${insert.tag}`,
    );
  }
  for (const execution of plan.executions) {
    actions.push(
      `直接执行迁移 ${execution.entry.tag}（${execution.entry.statements.length} 条语句，绕过水位）+ INSERT 记录`,
    );
    rollback.push(
      `DELETE FROM ${MIGRATIONS_SCHEMA}."${MIGRATIONS_TABLE}" WHERE hash = '${execution.entry.hash}' AND created_at = ${execution.entry.when};  -- ${execution.entry.tag}（若已执行）`,
    );
    rollback.push(...execution.rollback);
  }
  return { actions, rollback };
}

/** 报告渲染：体检表 + 待执行动作 + 回滚语句。 */
export function renderReport(
  plan: RepairPlan,
  databaseUrl: string,
  recordCount: number,
  applied: boolean,
): string {
  const lines: string[] = [];
  lines.push(`迁移状态体检：${databaseUrl}`);
  lines.push(
    `journal 条目 ${plan.analyses.length} 条；库内记录 ${recordCount} 条（孤立 ${plan.orphans.length} 条）；` +
      `对齐后水位 max(created_at)=${plan.effectiveMax}`,
  );
  lines.push("");
  for (const analysis of plan.analyses) {
    lines.push(`  ${analysis.entry.tag.padEnd(32)} ${statusText(analysis)}`);
  }
  lines.push("");

  if (plan.warnings.length > 0) {
    lines.push("提示：");
    for (const warning of plan.warnings) lines.push(`  - ${warning}`);
    lines.push("");
  }
  if (plan.errors.length > 0) {
    lines.push("阻断问题（本工具不会自动处理）：");
    for (const error of plan.errors) lines.push(`  ✖ ${error}`);
    lines.push("");
  }

  if (plan.pending.length > 0) {
    lines.push(
      `对齐后将由 pnpm db:migrate 正常应用：${plan.pending.map((entry) => entry.tag).join("、")}`,
    );
    lines.push("");
  }
  for (const execution of plan.executions) {
    lines.push(
      `⚠ 水位空洞：${execution.entry.tag} 对象完全缺失，却排在已应用迁移之前（when=${execution.entry.when} <= ${plan.effectiveMax}），` +
        "drizzle 永远不会重放它——只能直接执行。",
    );
    if (execution.removed.length > 0) {
      lines.push(`  该迁移会删除：${execution.removed.join("、")}（回滚需人工恢复）`);
    }
  }
  if (plan.executions.length > 0) lines.push("");

  const { actions, rollback } = planLines(plan);
  if (actions.length === 0) {
    lines.push("✔ 记录与 journal 已一致，无需对齐。");
    return lines.join("\n");
  }

  lines.push(applied ? "已执行的动作：" : "将执行的动作（默认只读，不写库）：");
  for (const action of actions) lines.push(`  ${action}`);
  lines.push("");
  lines.push(applied ? "如需回滚，执行：" : "确认无误后执行 pnpm db:repair -- --apply；回滚语句：");
  for (const statement of rollback) lines.push(`  ${statement}`);
  return lines.join("\n");
}
