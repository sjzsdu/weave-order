/**
 * OCR spike runner（一次性评测脚本，不进入生产依赖）。
 *
 * 两条路线：
 *   route-a: 多模态大模型直抽字段（qwen3-vl-plus，单次调用）
 *   route-b: 专用 OCR（qwen3.5-ocr）→ 文本模型抽取字段（qwen-plus）
 *
 * 用法：
 *   DASHSCOPE_API_KEY=... node scripts/ocr-spike/run.mjs \
 *     --manifest data/ocr-spike/manifest.json \
 *     --out data/ocr-spike/runs/2026-11-20
 *
 * 只看某条路线：--engine route-a|route-b（可重复）。
 * 图片不入库；清单只保留路径与真值，重跑前需把图片放回 manifest 指向的位置。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";

const DEFAULTS = {
  baseUrl: process.env.OCR_SPIKE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
  routeA: process.env.OCR_SPIKE_ROUTE_A_MODEL ?? "qwen3-vl-plus",
  ocr: process.env.OCR_SPIKE_OCR_MODEL ?? "qwen3.5-ocr",
  extract: process.env.OCR_SPIKE_EXTRACT_MODEL ?? "qwen-plus",
  concurrency: Number(process.env.OCR_SPIKE_CONCURRENCY ?? 4),
  attempts: Number(process.env.OCR_SPIKE_ATTEMPTS ?? 3),
  timeoutMs: Number(process.env.OCR_SPIKE_TIMEOUT_MS ?? 120_000),
};

const CARD_FIELDS = ["company", "contact", "title", "phone", "tel", "address", "business", "email"];
const LABEL_FIELDS = ["product", "composition", "gsm", "width", "lot", "supplier"];

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

function parseArgs(argv) {
  const out = { engines: [], manifest: "data/ocr-spike/manifest.json", out: null, limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manifest") out.manifest = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--engine") out.engines.push(argv[++i]);
    else if (arg === "--limit") out.limit = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log("node scripts/ocr-spike/run.mjs [--manifest path] [--out dir] [--engine route-a|route-b] [--limit n]");
      process.exit(0);
    } else throw new Error(`未知参数：${arg}`);
  }
  if (out.engines.length === 0) out.engines = ["route-a", "route-b"];
  return out;
}

function promptFor(kind) {
  if (kind === "card") {
    return [
      "你是纺织贸易公司的资料录入员。请从这张名片图片中抽取字段。",
      "字段：company 公司全称；contact 联系人姓名；title 职务；phone 手机号（标有 手机/Mobile 的号码；只有一个号码时放这里）；tel 固定电话（标有 电话/Tel 的号码）；address 地址；business 主营业务或产品；email 邮箱。",
      "只输出一个 JSON 对象，键名必须是上面八个英文字段。",
      "证据约束：company 只填名片上印出的完整公司名，品牌名不算公司全称；business 只在名片明确写出 主营/业务/产品 时填写，不得根据公司名推断；无法确认或图片中没有的字段输出空字符串，严禁猜测、补全或翻译。",
    ].join("\n");
  }
  return [
    "你是纺织贸易公司的面料资料录入员。请从这张面料/服装标签图片中抽取字段。",
    "字段：product 品名；composition 成分（按标签原文，含百分比）；gsm 克重（g/m² 或 GSM）；width 门幅（cm 或英寸）；lot 批号/色号/款号；supplier 供应商或品牌方。",
    "只输出一个 JSON 对象，键名必须是上面六个英文字段。",
    "证据约束：product 只在标签明确印有 品名/商品名/Product 时填写，品牌名、系列名、公司名都不是品名；gsm 只在明确标注 克重/GSM/g/m² 时填写，净重、尺码、件重都不算；width 只在明确标注 门幅/幅宽/Width 时填写，服装尺码（170/90）和床品尺寸（150*200cm）都不算；lot 只在明确标注 批号/色号/款号/货号/型号/SN 时填写，品牌名不算；supplier 填标签上印制的公司主体，不填广告语或品牌口号；composition 只填纤维成分百分比，忽略洗涤说明。无法确认或标签上没有的字段输出空字符串，严禁猜测或用常见值补全。",
  ].join("\n");
}

function extractPrompt(kind) {
  return [
    `下面是一张${kind === "card" ? "名片" : "面料/服装标签"}的 OCR 文本，可能包含识别错误、换行错位和无关内容。`,
    "请只依据这段文本抽取字段，不要引入外部知识。",
    promptFor(kind),
  ].join("\n");
}

async function callChat({ apiKey, baseUrl, model, content, maxTokens = 800 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULTS.timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [{ role: "user", content }],
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    const reply = body?.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) throw new Error("空回复");
    return { reply, usage: body.usage ?? {}, latencyMs: performance.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(fn) {
  let lastError;
  for (let attempt = 1; attempt <= DEFAULTS.attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < DEFAULTS.attempts) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

function parseJsonReply(reply, fields) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  const raw = (fenced?.[1] ?? reply).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`回复不是 JSON：${reply.slice(0, 120)}`);
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const out = {};
  for (const field of fields) {
    const value = parsed[field];
    out[field] = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  }
  return out;
}

function imageContent(mime, base64, prompt) {
  return [
    { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
    { type: "text", text: prompt },
  ];
}

async function runRouteA(sample, apiKey, baseUrl) {
  const mime = MIME[extname(sample.path).toLowerCase()];
  const base64 = (await readFile(sample.path)).toString("base64");
  const fields = sample.kind === "card" ? CARD_FIELDS : LABEL_FIELDS;
  const result = await withRetry(() =>
    callChat({
      apiKey,
      baseUrl,
      model: DEFAULTS.routeA,
      content: imageContent(mime, base64, promptFor(sample.kind)),
      maxTokens: 800,
    }),
  );
  return { ...result, fields: parseJsonReply(result.reply, fields) };
}

async function runRouteB(sample, apiKey, baseUrl) {
  const mime = MIME[extname(sample.path).toLowerCase()];
  const base64 = (await readFile(sample.path)).toString("base64");
  const fields = sample.kind === "card" ? CARD_FIELDS : LABEL_FIELDS;
  const ocr = await withRetry(() =>
    callChat({
      apiKey,
      baseUrl,
      model: DEFAULTS.ocr,
      content: imageContent(mime, base64, "提取图中所有文字，按阅读顺序输出，保留换行。不要输出坐标或解释。"),
      maxTokens: 1500,
    }),
  );
  const extraction = await withRetry(() =>
    callChat({
      apiKey,
      baseUrl,
      model: DEFAULTS.extract,
      content: `${extractPrompt(sample.kind)}\n\nOCR 文本：\n${ocr.reply}`,
      maxTokens: 600,
    }),
  );
  return {
    fields: parseJsonReply(extraction.reply, fields),
    ocrText: ocr.reply,
    usage: {
      prompt_tokens: (ocr.usage.prompt_tokens ?? 0) + (extraction.usage.prompt_tokens ?? 0),
      completion_tokens: (ocr.usage.completion_tokens ?? 0) + (extraction.usage.completion_tokens ?? 0),
    },
    latencyMs: ocr.latencyMs + extraction.latencyMs,
    stages: { ocrMs: Math.round(ocr.latencyMs), extractMs: Math.round(extraction.latencyMs) },
  };
}

const PUNCT = /[\s,，。.;；:：、/\\|·\-—_()（）[\]【】<>《》"'“”‘’#*&@+%]/g;
function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(PUNCT, "");
}
function normalizePhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.replace(/^86(?=1\d{10}$)/, "");
}
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
function similarity(a, b) {
  if (!a && !b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
}

function compareValue(predicted, truth, phoneLike, fuzzyOnly = false) {
  const p = phoneLike ? normalizePhone(predicted) : normalize(predicted);
  const t = phoneLike ? normalizePhone(truth) : normalize(truth);
  if (!t) return { status: p ? "hallucinated" : "empty_ok" };
  if (!p) return { status: "missing" };
  if (p === t) return { status: "exact" };
  if (similarity(p, t) >= 0.9) return { status: "fuzzy" };
  // 文本字段「可用」判定：一方完整包含另一方，且长度接近（如「TecTake」vs「TecTake GmbH」）。
  if (!fuzzyOnly && !phoneLike) {
    const [short, long] = p.length <= t.length ? [p, t] : [t, p];
    if (short.length >= 4 && long.includes(short) && short.length / long.length >= 0.6) {
      return { status: "contains" };
    }
  }
  return { status: "wrong" };
}

function compareField(field, predicted, truth) {
  const phoneLike = field === "phone" || field === "tel" || field === "lot";
  return compareValue(predicted, truth, phoneLike);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(engineName, results, samples) {
  const kinds = ["card", "label"];
  const summary = { engine: engineName, kinds: {}, total: { exact: 0, scored: 0, hallucinated: 0, emptyTruth: 0 } };
  for (const kind of kinds) {
    const fields = kind === "card" ? CARD_FIELDS : LABEL_FIELDS;
    const kindResults = results.filter((r) => r.kind === kind && !r.error);
    const fieldStats = {};
    for (const field of fields) {
      fieldStats[field] = { scored: 0, exact: 0, fuzzy: 0, contains: 0, wrong: 0, missing: 0, hallucinated: 0, emptyTruth: 0 };
    }
    for (const r of kindResults) {
      const sample = samples.find((s) => s.id === r.id);
      // 设计样卡、真值存疑样本不计入准确率，避免用不可靠真值下结论。
      if (sample.mock || sample.gtUncertain) continue;
      for (const field of fields) {
        const truth = sample.groundTruth?.[field] ?? "";
        const outcome = compareField(field, r.fields[field], truth);
        const stat = fieldStats[field];
        if (!normalize(truth)) {
          stat.emptyTruth += 1;
          if (outcome.status === "hallucinated") stat.hallucinated += 1;
          continue;
        }
        stat.scored += 1;
        if (outcome.status === "exact") stat.exact += 1;
        else if (outcome.status === "fuzzy") stat.fuzzy += 1;
        else if (outcome.status === "contains") stat.contains += 1;
        else if (outcome.status === "missing") stat.missing += 1;
        else stat.wrong += 1;
        summary.total.scored += 1;
        if (outcome.status === "exact") summary.total.exact += 1;
      }
      summary.total.hallucinated += fields.filter((f) => {
        const truth = sample.groundTruth?.[f] ?? "";
        return !normalize(truth) && compareField(f, r.fields[f], truth).status === "hallucinated";
      }).length;
    }
    // 电话字段合并评估：名片上手机/固话经常混排，逐字段归属不是业务关心的重点。
    const phoneSamples = kind === "card" ? kindResults.filter((r) => {
      const s = samples.find((x) => x.id === r.id);
      return s && !s.mock && !s.gtUncertain && (normalize(s.groundTruth.phone) || normalize(s.groundTruth.tel));
    }) : [];
    let phoneUsable = 0;
    for (const r of phoneSamples) {
      const s = samples.find((x) => x.id === r.id);
      const ok = ["phone", "tel"].some((pf) => ["phone", "tel"].some((tf) => {
        const status = compareValue(r.fields[pf], s.groundTruth[tf], true).status;
        return status === "exact" || status === "fuzzy" || status === "contains";
      }));
      if (ok) phoneUsable += 1;
    }
    summary.total.emptyTruth += fields.reduce((acc, f) => acc + fieldStats[f].emptyTruth, 0);
    const latencies = kindResults.map((r) => r.latencyMs);
    const tokens = kindResults.map((r) => (r.usage?.prompt_tokens ?? 0) + (r.usage?.completion_tokens ?? 0));
    summary.kinds[kind] = {
      samples: kindResults.length,
      errors: results.filter((r) => r.kind === kind && r.error).length,
      fields: fieldStats,
      latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.length ? Math.max(...latencies) : null },
      phone: { samples: phoneSamples.length, usable: phoneUsable },
      tokens: { avg: tokens.reduce((a, b) => a + b, 0) / Math.max(tokens.length, 1) },
    };
  }
  summary.total.accuracy = summary.total.scored ? summary.total.exact / summary.total.scored : null;
  return summary;
}

function formatPct(n) {
  return n == null ? "-" : `${(n * 100).toFixed(1)}%`;
}

function renderReport(manifest, runs) {
  const lines = [];
  lines.push(`# OCR spike 自动评测结果`, "");
  lines.push(`数据集：${manifest.dataset}；样本：${manifest.samples.length}（名片 ${manifest.samples.filter((s) => s.kind === "card").length} / 标签 ${manifest.samples.filter((s) => s.kind === "label").length}）。`, "");
  lines.push("准确率按「真值非空的字段」计，逐字段判定；exact = 归一化后完全一致，fuzzy = 编辑相似度 ≥ 0.9。标记 mock 的设计样卡不计入统计。", "");
  for (const [name, summary] of Object.entries(runs)) {
    lines.push(`## ${name}`, "");
    for (const kind of ["card", "label"]) {
      const block = summary.kinds[kind];
      const fields = kind === "card" ? CARD_FIELDS : LABEL_FIELDS;
      lines.push(`### ${kind === "card" ? "名片" : "面料/标签"}（${block.samples} 张，失败 ${block.errors}）`, "");
      lines.push("| 字段 | 真值非空 | exact | fuzzy | 包含 | 缺失 | 错误 | 幻觉(真值为空却输出) | exact | 可用(含包含) |");
      lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
      for (const field of fields) {
        const s = block.fields[field];
        const usable = s.exact + s.fuzzy + s.contains;
        lines.push(
          `| ${field} | ${s.scored} | ${s.exact} | ${s.fuzzy} | ${s.contains} | ${s.missing} | ${s.wrong} | ${s.hallucinated}/${s.emptyTruth} | ${formatPct(s.scored ? s.exact / s.scored : null)} | ${formatPct(s.scored ? usable / s.scored : null)} |`,
        );
      }
      if (kind === "card") {
        lines.push("", `手机/固话合并可用：${formatPct(block.phone.samples ? block.phone.usable / block.phone.samples : null)}（${block.phone.usable}/${block.phone.samples}）。`);
      }
      lines.push("");
      lines.push(`时延 P50/P95/max：${Math.round(block.latencyMs.p50 ?? 0)} / ${Math.round(block.latencyMs.p95 ?? 0)} / ${Math.round(block.latencyMs.max ?? 0)} ms；平均 token：${Math.round(block.tokens.avg)}。`, "");
    }
    lines.push(`总体 exact 准确率：${formatPct(summary.total.accuracy)}（${summary.total.exact}/${summary.total.scored}）；幻觉字段：${summary.total.hallucinated}/${summary.total.emptyTruth}。`, "");
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("缺少 DASHSCOPE_API_KEY");
  const manifest = JSON.parse(await readFile(args.manifest, "utf8"));
  const samples = args.limit ? manifest.samples.slice(0, args.limit) : manifest.samples;
  const outDir = args.out ?? join("data/ocr-spike/runs", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(outDir, { recursive: true });
  await mkdir(join(outDir, "predictions"), { recursive: true });

  const runners = { "route-a": runRouteA, "route-b": runRouteB };
  const all = {};
  for (const engine of args.engines) {
    const run = runners[engine];
    if (!run) throw new Error(`未知引擎：${engine}`);
    console.log(`\n== ${engine}：${samples.length} 张`);
    const results = new Array(samples.length);
    let cursor = 0;
    async function worker() {
      while (cursor < samples.length) {
        const index = cursor++;
        const sample = samples[index];
        const started = Date.now();
        try {
          const result = await run(sample, apiKey, DEFAULTS.baseUrl);
          results[index] = { id: sample.id, kind: sample.kind, ...result, latencyMs: Math.round(Date.now() - started) };
          console.log(`  ✓ ${sample.id} ${Math.round(Date.now() - started)}ms`);
        } catch (error) {
          results[index] = { id: sample.id, kind: sample.kind, error: String(error), latencyMs: Date.now() - started };
          console.log(`  ✗ ${sample.id} ${String(error).slice(0, 120)}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, DEFAULTS.concurrency) }, worker));
    const summary = summarize(engine, results, samples);
    all[engine] = { summary, results };
    await writeFile(
      join(outDir, "predictions", `${engine}.json`),
      JSON.stringify(results, null, 2),
    );
  }

  const report = renderReport(manifest, Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.summary])));
  await writeFile(join(outDir, "report.md"), `${report}\n`);
  await writeFile(join(outDir, "summary.json"), JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.summary])), null, 2));
  console.log(`\n结果写入 ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
