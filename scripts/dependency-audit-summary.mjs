#!/usr/bin/env node
/**
 * 把 `pnpm audit --prod --json` 的结果渲染成 GitHub Job Summary。
 *
 * 契约：**只告警，不阻断**。存量告警不应该卡住所有 PR，
 * 所以脚本无论如何都 exit 0；阈值（critical/high 限期评估）写在报告里，
 * 由人按报告推进，扫描失败（网络/registry 故障）也不会让 CI 变红。
 */
import { readFile } from "node:fs/promises";

const SEVERITIES = ["critical", "high", "moderate", "low", "info"];
const LABELS = { critical: "紧急", high: "高", moderate: "中", low: "低", info: "提示" };

function readAudit(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalize(report) {
  /** @type {{name: string, severity: string, title: string, url: string, paths: string[]}[]} */
  const rows = [];
  if (!report) return rows;

  // npm / pnpm 10 的 auditReportVersion 2 形状。
  if (report.vulnerabilities && typeof report.vulnerabilities === "object") {
    for (const [name, entry] of Object.entries(report.vulnerabilities)) {
      const via = (entry.via ?? []).filter((item) => typeof item === "object");
      const titles = via.map((item) => item.title).filter(Boolean);
      rows.push({
        name,
        severity: entry.severity ?? "info",
        title: titles[0] ?? (typeof entry.via?.[0] === "string" ? entry.via[0] : "—"),
        url: via[0]?.url ?? "",
        paths: entry.effects?.length ? [name, ...entry.effects] : [name],
      });
    }
    return rows;
  }

  // 旧版 advisories 形状（pnpm 8/9 仍可能返回）。
  if (report.advisories && typeof report.advisories === "object") {
    for (const advisory of Object.values(report.advisories)) {
      rows.push({
        name: advisory.module_name ?? "—",
        severity: advisory.severity ?? "info",
        title: advisory.title ?? "—",
        url: advisory.url ?? "",
        paths: [advisory.module_name ?? "—"],
      });
    }
  }
  return rows;
}

function countBySeverity(rows) {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const row of rows) {
    counts[row.severity] = (counts[row.severity] ?? 0) + 1;
  }
  return counts;
}

const file = process.argv[2] ?? "audit.json";
let raw = "";
try {
  raw = await readFile(file, "utf8");
} catch {
  raw = "";
}

const report = readAudit(raw);
const rows = normalize(report);
const counts = countBySeverity(rows);
const total = rows.length;

const lines = ["## 依赖漏洞扫描（`pnpm audit --prod`）", ""];

if (!report) {
  lines.push(
    "> ⚠️ 扫描没有产出可解析报告（registry 不可达或 audit 失败），本条只记录，不影响合并。",
    "",
    "本地复现：`pnpm audit --prod`",
  );
} else {
  const summary = SEVERITIES.map((severity) => `${LABELS[severity]} ${counts[severity]}`).join(
    " · ",
  );
  lines.push(`共 **${total}** 条：${summary}`, "");
  lines.push(
    "阈值策略：**critical / high 需在本周内评估并给出处置**；moderate / low 随常规依赖升级处理。",
    "本作业只告警（不阻断合并），处置记录追加到相关 issue。",
    "",
  );

  if (total > 0) {
    lines.push("| 严重度 | 包 | 摘要 | 链接 |", "| --- | --- | --- | --- |");
    for (const row of rows.slice(0, 30)) {
      const title = String(row.title).replaceAll("|", "\\|");
      const link = row.url ? `[advisory](${row.url})` : "—";
      lines.push(
        `| ${LABELS[row.severity] ?? row.severity} | \`${row.name}\` | ${title} | ${link} |`,
      );
    }
    if (rows.length > 30)
      lines.push("", `…其余 ${rows.length - 30} 条见完整 \`audit.json\` 产物。`);
  }
}

lines.push("", `生成时间：${new Date().toISOString()}`);
process.stdout.write(`${lines.join("\n")}\n`);
