import { z } from "zod";
import { EntityId, Timestamp } from "./domain";

/**
 * 业务编号规则 · 唯一契约来源。
 *
 * 本文件只放纯函数与纯数据，不依赖数据库与运行环境，前后端同包引用
 * （与 `field-options.ts` / `print.ts` 同一纪律）。三处消费方——服务端取号、
 * 设置页实时预览、保存时校验——必须共用同一套解析与渲染逻辑，各写一份
 * 必然漂移，表现为「预览生成的编号和实际落库的不一样」。
 */

// ── 实体类型 ────────────────────────────────────────────────────────────

export const CODE_ENTITY_TYPES = [
  "customer",
  "sample",
  "quote",
  "order",
  "sample_shipment",
] as const;
export const CodeEntityType = z.enum(CODE_ENTITY_TYPES);
export type CodeEntityType = z.infer<typeof CodeEntityType>;

/** 各实体默认字头（`{PREFIX}` 占位符的渲染值）。 */
export const CODE_ENTITY_PREFIX: Readonly<Record<CodeEntityType, string>> = {
  customer: "C",
  sample: "S",
  quote: "BJ",
  order: "DD",
  sample_shipment: "JY",
};

/** 设置页与错误文案共用的实体中文名；与 CodeEntityType 同处一份，避免两处漂移。 */
export const CODE_ENTITY_LABEL: Readonly<Record<CodeEntityType, string>> = {
  customer: "客户",
  sample: "样品",
  quote: "报价",
  order: "订单",
  sample_shipment: "寄样单",
};

/** 各实体编号的字节上限。样品要塞进二维码 token，最严。 */
export const CODE_ENTITY_MAX_BYTES: Readonly<Record<CodeEntityType, number>> = {
  customer: 64,
  sample: 32,
  quote: 64,
  order: 64,
  sample_shipment: 64,
};

// ── 契约 schema ─────────────────────────────────────────────────────────

/** 编号规则读模型。 */
export const CodeRule = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    entityType: CodeEntityType,
    template: z.string().min(1).max(128),
    /** 套用的预设 key；null = 用户自定义。 */
    presetKey: z.string().max(64).nullable(),
    enabled: z.boolean(),
    createdBy: z.string().max(128),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type CodeRule = z.infer<typeof CodeRule>;

/** 保存规则；entityType 在路径上，放 body 里便于一次校验。 */
export const SaveCodeRuleInput = z
  .object({
    entityType: CodeEntityType,
    template: z.string().min(1).max(128),
    presetKey: z.string().max(64).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type SaveCodeRuleInput = z.infer<typeof SaveCodeRuleInput>;

/** 预览：不写库、不占号，只渲染示例与宽度检查。 */
export const CodeRulePreviewInput = z
  .object({
    entityType: CodeEntityType,
    template: z.string().min(1).max(128),
  })
  .strict();
export type CodeRulePreviewInput = z.infer<typeof CodeRulePreviewInput>;

export const CodeRulePreviewItem = z
  .object({
    seq: z.number().int().positive(),
    code: z.string(),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export const CodeRulePreviewResult = z
  .object({
    entityType: CodeEntityType,
    template: z.string(),
    /** 规则分桶（去掉序号后的字面前缀），用于说明「换天/改规则换桶」。 */
    bucket: z.string(),
    examples: z.array(CodeRulePreviewItem).min(1),
    maxBytes: z.number().int().positive(),
    /** 静态容量预算字节数（SEQ 按 n+1 位估）。 */
    budgetBytes: z.number().int().nonnegative(),
    valid: z.boolean(),
    errors: z.array(
      z.object({ code: z.string(), message: z.string() }).strict(),
    ),
  })
  .strict();
export type CodeRulePreviewResult = z.infer<typeof CodeRulePreviewResult>;

export const CodeRuleListResponse = z
  .object({
    rules: z.array(CodeRule),
    presets: z.array(
      z
        .object({
          key: z.string(),
          name: z.string(),
          templates: z.record(CodeEntityType, z.string()),
        })
        .strict(),
    ),
  })
  .strict();
export type CodeRuleListResponse = z.infer<typeof CodeRuleListResponse>;

// ── 模板解析 ────────────────────────────────────────────────────────────

/** 模板片段：字面量或占位符。 */
export type TemplateSegment =
  | { kind: "literal"; value: string }
  | { kind: "prefix" }
  | { kind: "date"; token: DateToken }
  | { kind: "seq"; width: number };

export type DateToken = "YY" | "MM" | "DD" | "YYYY" | "YYMMDD" | "YYYYMM" | "YYYYMMDD";

const DATE_TOKENS = ["YYYYMMDD", "YYMMDD", "YYYYMM", "YYYY", "YY", "MM", "DD"] as const;
const PLACEHOLDER_RE = /\{([A-Za-z0-9_:]+)\}/g;
const SEQ_RE = /^SEQ:([1-8])$/;

export interface TemplateParseResult {
  segments: TemplateSegment[];
  /** 序号片段在 segments 里的下标；不存在为 -1。 */
  seqIndex: number;
  errors: TemplateValidationIssue[];
}

export interface TemplateValidationIssue {
  code:
    | "CODE_TEMPLATE_UNKNOWN_PLACEHOLDER"
    | "CODE_TEMPLATE_SEQ_REQUIRED"
    | "CODE_TEMPLATE_SEQ_MULTIPLE"
    | "CODE_TEMPLATE_NO_LITERAL"
    | "CODE_TEMPLATE_NON_ASCII_LITERAL"
    | "CODE_TEMPLATE_TOO_LONG";
  message: string;
}

/**
 * 解析模板为片段序列。纯函数：不抛异常，所有问题收进 `errors`，
 * 让「预览」和「保存」共用同一份判定，不出现「预览能过、保存被拒」。
 */
export function parseCodeTemplate(template: string): TemplateParseResult {
  const segments: TemplateSegment[] = [];
  const errors: TemplateValidationIssue[] = [];
  let cursor = 0;
  let seqIndex = -1;
  let seqCount = 0;
  let hasLiteralOrDate = false;

  const pushLiteral = (raw: string) => {
    if (raw.length === 0) return;
    if (!/^[\x20-\x7E]+$/.test(raw)) {
      errors.push({
        code: "CODE_TEMPLATE_NON_ASCII_LITERAL",
        message: "模板字面部分只能是 ASCII 可打印字符（中文会画成方框）",
      });
    }
    segments.push({ kind: "literal", value: raw });
    hasLiteralOrDate = true;
  };

  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const start = match.index ?? 0;
    pushLiteral(template.slice(cursor, start));
    cursor = start + match[0].length;
    const token = match[1] ?? "";

    if (token === "PREFIX") {
      segments.push({ kind: "prefix" });
      hasLiteralOrDate = true;
      continue;
    }
    if ((DATE_TOKENS as readonly string[]).includes(token)) {
      segments.push({ kind: "date", token: token as DateToken });
      hasLiteralOrDate = true;
      continue;
    }
    const seqMatch = SEQ_RE.exec(token);
    if (seqMatch) {
      seqCount += 1;
      seqIndex = segments.length;
      segments.push({ kind: "seq", width: Number(seqMatch[1]) });
      continue;
    }
    errors.push({
      code: "CODE_TEMPLATE_UNKNOWN_PLACEHOLDER",
      message: `未知占位符 {${token}}`,
    });
  }
  pushLiteral(template.slice(cursor));

  if (seqCount === 0) {
    errors.push({ code: "CODE_TEMPLATE_SEQ_REQUIRED", message: "模板必须包含 {SEQ:n}" });
  } else if (seqCount > 1) {
    errors.push({ code: "CODE_TEMPLATE_SEQ_MULTIPLE", message: "{SEQ:n} 只能出现一次" });
  }
  if (!hasLiteralOrDate) {
    errors.push({
      code: "CODE_TEMPLATE_NO_LITERAL",
      message: "模板至少需要一个字面字符或日期占位符，以便分桶",
    });
  }
  return { segments, seqIndex, errors };
}

/** `SEQ` 之后的进位预留位数：容量预算按 n+1 位估。 */
export function templateBudgetBytes(template: string): number {
  const { segments } = parseCodeTemplate(template);
  return segments.reduce<number>((sum, segment) => {
    if (segment.kind === "literal") return sum + utf8Bytes(segment.value);
    if (segment.kind === "prefix") return sum + 2; // 最长默认字头 BJ / JY
    if (segment.kind === "date") return sum + dateTokenMaxBytes(segment.token);
    return sum + segment.width + 1; // SEQ:n → n+1 位
  }, 0);
}

function dateTokenMaxBytes(token: DateToken): number {
  switch (token) {
    case "YY":
    case "MM":
    case "DD":
      return 2;
    case "YYYY":
      return 4;
    case "YYYYMM":
      return 6;
    case "YYMMDD":
      return 6;
    case "YYYYMMDD":
      return 8;
  }
}

/** UTF-8 字节数；Node 与浏览器都可用（不用 Buffer）。 */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

// ── 渲染 ────────────────────────────────────────────────────────────────

/** 北京时间（固定 +8h 偏移，不用 Intl，避免运行环境 ICU 差异）。 */
function beijingParts(now: Date): { yy: string; mm: string; dd: string; yyyy: string } {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const yyyy = String(beijing.getUTCFullYear()).padStart(4, "0");
  return {
    yyyy,
    yy: yyyy.slice(-2),
    mm: String(beijing.getUTCMonth() + 1).padStart(2, "0"),
    dd: String(beijing.getUTCDate()).padStart(2, "0"),
  };
}

function renderDateToken(token: DateToken, now: Date): string {
  const { yy, mm, dd, yyyy } = beijingParts(now);
  switch (token) {
    case "YY":
      return yy;
    case "MM":
      return mm;
    case "DD":
      return dd;
    case "YYYY":
      return yyyy;
    case "YYMMDD":
      return `${yy}${mm}${dd}`;
    case "YYYYMM":
      return `${yyyy}${mm}`;
    case "YYYYMMDD":
      return `${yyyy}${mm}${dd}`;
  }
}

export interface RenderCodeInput {
  entityType: CodeEntityType;
  template: string;
  now: Date;
  seq: number;
}

/**
 * 用模板渲染编号。{SEQ:n} 左补零到 n 位；实际位数超过 n 时自然进位，不截断。
 * 调用方必须先确认模板合法（errors 为空），否则此处按 best-effort 渲染。
 */
export function renderCode(input: RenderCodeInput): string {
  const { segments } = parseCodeTemplate(input.template);
  let out = "";
  for (const segment of segments) {
    switch (segment.kind) {
      case "literal":
        out += segment.value;
        break;
      case "prefix":
        out += CODE_ENTITY_PREFIX[input.entityType];
        break;
      case "date":
        out += renderDateToken(segment.token, input.now);
        break;
      case "seq": {
        const digits = String(input.seq);
        out += digits.length >= segment.width ? digits : digits.padStart(segment.width, "0");
        break;
      }
    }
  }
  return out;
}

/**
 * 分桶键：模板去掉序号后的字面部分（按给定时间渲染）。
 * 换天 / 改规则渲染结果不同 → 序号独立起算，天然不追溯历史。
 */
export function codeBucket(input: Omit<RenderCodeInput, "seq">): string {
  const { segments } = parseCodeTemplate(input.template);
  let out = "";
  for (const segment of segments) {
    if (segment.kind === "seq") continue;
    if (segment.kind === "literal") out += segment.value;
    else if (segment.kind === "prefix") out += CODE_ENTITY_PREFIX[input.entityType];
    else out += renderDateToken(segment.token, input.now);
  }
  return out;
}

// ── 校验与预览 ──────────────────────────────────────────────────────────

/** 完整校验：语法 + 实体字节上限（静态预算）。 */
export function validateCodeTemplate(
  template: string,
  entityType: CodeEntityType,
): TemplateValidationIssue[] {
  const parsed = parseCodeTemplate(template);
  const issues = [...parsed.errors];
  const maxBytes = CODE_ENTITY_MAX_BYTES[entityType];
  const budget = templateBudgetBytes(template);
  if (budget > maxBytes) {
    issues.push({
      code: "CODE_TEMPLATE_TOO_LONG",
      message: `模板容量预算 ${budget} 字节，超过 ${entityType} 的 ${maxBytes} 字节上限`,
    });
  }
  return issues;
}

/** 渲染 1/2/100 三条示例并给出宽度结果；供预览接口直接返回。 */
export function previewCodeRule(input: CodeRulePreviewInput): CodeRulePreviewResult {
  const now = new Date();
  const errors = validateCodeTemplate(input.template, input.entityType);
  const maxBytes = CODE_ENTITY_MAX_BYTES[input.entityType];
  const budgetBytes = templateBudgetBytes(input.template);
  const examples = [1, 2, 100].map((seq) => {
    const code = renderCode({ ...input, now, seq });
    return { seq, code, bytes: utf8Bytes(code) };
  });
  return {
    entityType: input.entityType,
    template: input.template,
    bucket: codeBucket({ ...input, now }),
    examples,
    maxBytes,
    budgetBytes,
    valid: errors.length === 0 && examples.every((item) => item.bytes <= maxBytes),
    errors: errors.map((issue) => ({ code: issue.code, message: issue.message })),
  };
}

// ── 内置预设 ────────────────────────────────────────────────────────────

export interface CodeRulePreset {
  key: string;
  name: string;
  templates: Record<CodeEntityType, string>;
}

export const CODE_RULE_PRESETS: readonly CodeRulePreset[] = [
  {
    key: "classic",
    name: "沿用现状",
    templates: {
      customer: "C{YYMMDD}-{SEQ:4}",
      sample: "S{YYMMDD}-{SEQ:4}",
      quote: "BJ{YYMMDD}-{SEQ:4}",
      order: "DD{YYMMDD}-{SEQ:4}",
      sample_shipment: "JY{YYMMDD}-{SEQ:4}",
    },
  },
  {
    key: "compact",
    name: "紧凑无分隔符",
    templates: {
      customer: "C{YYMMDD}{SEQ:4}",
      sample: "S{YYMMDD}{SEQ:4}",
      quote: "BJ{YYMMDD}{SEQ:4}",
      order: "DD{YYMMDD}{SEQ:4}",
      sample_shipment: "JY{YYMMDD}{SEQ:4}",
    },
  },
  {
    key: "yearly",
    name: "年月分组",
    templates: {
      customer: "C{YYYYMM}-{SEQ:4}",
      sample: "S{YYYYMM}-{SEQ:4}",
      quote: "BJ{YYYYMM}-{SEQ:4}",
      order: "DD{YYYYMM}-{SEQ:4}",
      sample_shipment: "JY{YYYYMM}-{SEQ:4}",
    },
  },
  {
    key: "plain",
    name: "纯字头流水",
    templates: {
      customer: "{PREFIX}{SEQ:5}",
      sample: "{PREFIX}{SEQ:5}",
      quote: "{PREFIX}{SEQ:5}",
      order: "{PREFIX}{SEQ:5}",
      sample_shipment: "{PREFIX}{SEQ:5}",
    },
  },
] as const;

/** 无规则 / 规则停用时的回退模板。 */
export function defaultCodeTemplate(entityType: CodeEntityType): string {
  const classic = CODE_RULE_PRESETS.find((preset) => preset.key === "classic");
  return classic?.templates[entityType] ?? "C{YYMMDD}-{SEQ:4}";
}
