import { IntentUnderstanding } from "@weave-order/schema";
import type {
  InboundFieldCard,
  InboundTask,
  IntentKind,
  IntentUnderstanding as Understanding,
  JsonValue,
  ResourceFieldSourceKind,
} from "@weave-order/schema";

/**
 * 理解卡的纯逻辑：分派意图、把 OCR 字段变成「值 + 出处 + 待补」，
 * 并判断「现在能不能执行」。不碰数据库、不调用模型，单测直接打这里。
 *
 * 硬约束来自 `docs/ocr-spike.md`：
 * - 克重、门幅、批号、主营、品名一律不预填，即使 OCR 给出了值；
 * - OCR 为空 = 留空，不用常识/默认值补齐；
 * - 可预填字段也必须 PENDING，等用户逐字段确认。
 */

export type InboundSourceKindHint = "bizcard" | "label" | "fabric" | "document" | "auto";

export interface InboundSourceInsight {
  sourceId: string;
  kind: InboundSourceKindHint;
  ocrStatus: "PENDING" | "SUCCEEDED" | "FAILED";
  /** OCR 抽取出的字段；失败时为空对象。 */
  fields: Record<string, string>;
  ocrText: string | null;
  failureCode: string | null;
}

export interface BuildUnderstandingInput {
  text: string;
  sources: InboundSourceInsight[];
  context?: Record<string, unknown> | null;
  /** 用户通过 /revise 显式指定 kind 时优先。 */
  kind?: IntentKind | null;
  /** 已有槽位（start/revise 时合并）。 */
  slots?: Record<string, JsonValue>;
}

const QUOTE_PATTERN = /报价|什么价|价格|单价|多少钱|报个价|quote|price/iu;
const SAMPLE_PATTERN = /样品|打样|建样|寄样|米样|面料|布料|成分|克重|门幅|标签|label/iu;
const CUSTOMER_PATTERN = /名片|建档|建客户|新客户|客户资料|联系人|bizcard|card/iu;

const CUSTOMER_FIELD_LABELS: Record<string, string> = {
  name: "公司名称",
  contactName: "联系人",
  title: "职务",
  contactPhone: "手机/固话",
  contactEmail: "邮箱",
  address: "地址",
  business: "主营",
};

const SAMPLE_FIELD_LABELS: Record<string, string> = {
  name: "品名",
  composition: "成分",
  weight: "克重",
  width: "门幅",
  lot: "批号/色号",
  supplier: "供应商",
};

/** 按 OCR spike 结论，这些字段必须人工录入：即使模型输出也丢弃。 */
const MANUAL_HELP: Record<string, string> = {
  business: "名片常不写主营，模型容易从公司名推断，请手动填写",
  name: "标签上经常没有品名，品名必须人工填写",
  weight: "克重直接决定报价，必须人工录入（不要用净重/尺码代替）",
  width: "门幅直接决定报价，必须人工录入（尺码/床品尺寸不算）",
  lot: "批号/色号必须人工录入",
};

function textOf(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

/** 文本 + 附件提示 → 主意图。附件只做提示，最终仍由文本与用户纠正决定。 */
export function classifyInboundKind(input: {
  text: string;
  sources: Array<Pick<InboundSourceInsight, "kind">>;
  kindOverride?: IntentKind | null;
}): IntentKind {
  if (input.kindOverride && input.kindOverride !== "unknown") return input.kindOverride;
  const text = input.text ?? "";
  const hasCard = input.sources.some((source) => source.kind === "bizcard");
  const hasLabel = input.sources.some(
    (source) => source.kind === "label" || source.kind === "fabric",
  );

  const quote = textOf(text, QUOTE_PATTERN);
  const sample = textOf(text, SAMPLE_PATTERN) || hasLabel;
  const customer = textOf(text, CUSTOMER_PATTERN) || hasCard;

  if (quote && !customer && !sample) return "quote";
  if (quote && (customer || sample)) return "quote";
  if (customer && hasCard && !hasLabel) return "customer";
  if (sample && !customer) return "sample";
  if (customer) return "customer";
  if (hasLabel) return "sample";
  return "unknown";
}

function asText(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function field(
  fieldName: string,
  label: string,
  value: string,
  options: {
    sourceKind: ResourceFieldSourceKind;
    sourceId: string | null;
    required?: boolean;
    pending?: boolean;
    help?: string | null;
  },
): InboundFieldCard {
  return {
    fieldName,
    label,
    value: value.length > 0 ? value : "",
    sourceKind: options.sourceKind,
    sourceId: options.sourceId,
    status: "PENDING",
    required: options.required ?? false,
    pending: options.pending ?? value.length === 0,
    help: options.help ?? null,
  };
}

function ocrOrEmpty(fields: Record<string, string>, key: string): string {
  const value = fields[key];
  return typeof value === "string" ? value.trim() : "";
}

function customerFieldsFrom(source: InboundSourceInsight | null): InboundFieldCard[] {
  const ocr = source?.fields ?? {};
  const sourceId = source?.sourceId ?? null;
  const sourceKind: ResourceFieldSourceKind = source ? "bizcard" : "manual";
  const phone = ocrOrEmpty(ocr, "phone") || ocrOrEmpty(ocr, "tel");
  const out: InboundFieldCard[] = [];
  const prefill: Array<[string, string]> = [
    ["name", ocrOrEmpty(ocr, "company")],
    ["contactName", ocrOrEmpty(ocr, "contact")],
    ["title", ocrOrEmpty(ocr, "title")],
    ["contactPhone", phone],
    ["contactEmail", ocrOrEmpty(ocr, "email")],
    ["address", ocrOrEmpty(ocr, "address")],
  ];
  for (const [name, value] of prefill) {
    out.push(
      field(name, CUSTOMER_FIELD_LABELS[name] ?? name, value, {
        sourceKind,
        sourceId,
        required: name === "name",
      }),
    );
  }
  // 主营永远留空：模型从公司名推断出的「主营」是污染客户画像，不是识别结果。
  out.push(
    field("business", CUSTOMER_FIELD_LABELS.business ?? "主营", "", {
      sourceKind: "manual",
      sourceId: null,
      pending: true,
      help: MANUAL_HELP.business,
    }),
  );
  return out;
}

function sampleFieldsFrom(source: InboundSourceInsight | null): InboundFieldCard[] {
  const ocr = source?.fields ?? {};
  const sourceId = source?.sourceId ?? null;
  const sourceKind: ResourceFieldSourceKind = source ? "label" : "manual";
  const out: InboundFieldCard[] = [];
  const prefill: Array<[string, string]> = [
    ["composition", ocrOrEmpty(ocr, "composition")],
    ["supplier", ocrOrEmpty(ocr, "supplier")],
  ];
  for (const [name, value] of prefill) {
    out.push(field(name, SAMPLE_FIELD_LABELS[name] ?? name, value, { sourceKind, sourceId }));
  }
  for (const name of ["name", "weight", "width", "lot"]) {
    out.push(
      field(name, SAMPLE_FIELD_LABELS[name] ?? name, "", {
        sourceKind: "manual",
        sourceId: null,
        required: name === "name",
        pending: true,
        help: MANUAL_HELP[name] ?? null,
      }),
    );
  }
  return out;
}

/** 从文本里抓数量：`500 米` / `300kg` / `200 码`。抓不到就留空，不猜。 */
export function extractQuantitySlot(text: string): { value: number; unit: string } | null {
  const match = /(\d+(?:\.\d+)?)\s*(米|m(?![a-z])|码|yard|公斤|kg|千克|件|pc|pcs)/iu.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const raw = (match[2] ?? "").toLowerCase();
  const unit =
    raw === "米" || raw === "m"
      ? "meter"
      : raw === "码" || raw === "yard"
        ? "yard"
        : raw === "公斤" || raw === "kg" || raw === "千克"
          ? "kilogram"
          : "piece";
  return { value, unit };
}

function quoteSlots(
  input: BuildUnderstandingInput,
  existing: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const slots: Record<string, JsonValue> = { ...existing };
  const context = input.context ?? {};
  for (const key of ["customerId", "sampleId", "sampleCode", "customerName"]) {
    const value = context[key];
    if (typeof value === "string" && value.trim().length > 0 && !slots[key]) slots[key] = value;
  }
  if (!slots.quantity) {
    const quantity = extractQuantitySlot(input.text);
    if (quantity) {
      slots.quantity = quantity.value;
      slots.unit = quantity.unit;
    }
  }
  return slots;
}

function tasksFor(kind: IntentKind, sources: InboundSourceInsight[]): InboundTask[] {
  const tasks: InboundTask[] = [];
  const cards = sources.filter((source) => source.kind === "bizcard");
  const labels = sources.filter((source) => source.kind === "label" || source.kind === "fabric");
  for (const source of cards) {
    tasks.push({
      kind: "customer",
      sourceId: source.sourceId,
      label: "从名片建客户草稿",
      status: "READY",
      resourceId: null,
      resourceType: null,
      message: null,
    });
  }
  for (const source of labels) {
    tasks.push({
      kind: "sample",
      sourceId: source.sourceId,
      label: "从标签建样品草稿",
      status: "READY",
      resourceId: null,
      resourceType: null,
      message: null,
    });
  }
  if (kind === "quote") {
    tasks.push({
      kind: "quote",
      sourceId: null,
      label: "整理成报价",
      status: "READY",
      resourceId: null,
      resourceType: null,
      message: null,
    });
  }
  if (tasks.length === 0) {
    tasks.push({
      kind: kind === "unknown" ? "customer" : kind,
      sourceId: null,
      label: kind === "sample" ? "建样品草稿" : kind === "quote" ? "整理成报价" : "建客户草稿",
      status: "READY",
      resourceId: null,
      resourceType: null,
      message: null,
    });
  } else if (kind !== "quote") {
    const primaryExists = tasks.some(
      (task) => task.kind === (kind === "unknown" ? "customer" : kind),
    );
    if (!primaryExists) {
      tasks.push({
        kind: kind === "unknown" ? "customer" : kind,
        sourceId: null,
        label: kind === "sample" ? "建样品草稿" : "建客户草稿",
        status: "READY",
        resourceId: null,
        resourceType: null,
        message: null,
      });
    }
  }
  return tasks;
}

function quoteQuestions(slots: Record<string, JsonValue>): string[] {
  const questions: string[] = [];
  if (typeof slots.customerId !== "string" || slots.customerId.length === 0) {
    questions.push("这次报价给哪个客户？");
  }
  if (typeof slots.sampleId !== "string" || slots.sampleId.length === 0) {
    questions.push("报哪一款面料？");
  }
  if (typeof slots.quantity !== "number" || slots.quantity <= 0) {
    questions.push("数量是多少（米/公斤/码）？");
  }
  return questions;
}

function fieldsForKind(kind: IntentKind, sources: InboundSourceInsight[]): InboundFieldCard[] {
  if (kind === "quote") {
    // 报价的槽位（客户/样品/数量）放在 pendingQuestions 与 slots 里，
    // 这里不重复造字段，避免 UI 出现两套「数量」。
    return [];
  }
  if (kind === "sample") {
    const label = sources.find((source) => source.kind === "label" || source.kind === "fabric");
    return sampleFieldsFrom(label ?? null);
  }
  if (kind === "customer") {
    const card = sources.find((source) => source.kind === "bizcard");
    return customerFieldsFrom(card ?? null);
  }
  const first = sources[0];
  if (!first) return [];
  if (first.kind === "bizcard") return customerFieldsFrom(first);
  if (first.kind === "label" || first.kind === "fabric") return sampleFieldsFrom(first);
  return [];
}

function requiredMissing(fields: InboundFieldCard[]): string[] {
  return fields
    .filter((card) => card.required && (card.pending || asText(card.value).length === 0))
    .map((card) => card.label);
}

function summarize(
  kind: IntentKind,
  fields: InboundFieldCard[],
  slots: Record<string, JsonValue>,
  questions: string[],
): string {
  const kindLabel =
    kind === "quote"
      ? "报价"
      : kind === "sample"
        ? "建样品"
        : kind === "customer"
          ? "建客户"
          : "先确认要做什么";
  const parts: string[] = [`我理解你要做的是：${kindLabel}`];
  if (kind === "customer") {
    const name = fields.find((card) => card.fieldName === "name");
    if (name && asText(name.value)) parts.push(`客户「${asText(name.value)}」`);
  }
  if (kind === "sample") {
    const comp = fields.find((card) => card.fieldName === "composition");
    if (comp && asText(comp.value)) parts.push(`成分 ${asText(comp.value)}`);
  }
  if (kind === "quote") {
    const quantity = slots.quantity;
    const unit = typeof slots.unit === "string" ? slots.unit : "米";
    if (typeof quantity === "number")
      parts.push(`${quantity}${unit === "meter" ? " 米" : ` ${unit}`}`);
  }
  if (questions.length > 0) parts.push(`还差 ${questions.length} 项信息`);
  return parts.join(" · ").slice(0, 500);
}

/** 生成理解卡。纯函数，不做任何 I/O。 */
export function buildUnderstanding(input: BuildUnderstandingInput): Understanding {
  const kind = classifyInboundKind({
    text: input.text,
    sources: input.sources,
    ...(input.kind ? { kindOverride: input.kind } : {}),
  });
  const slots =
    kind === "quote" ? quoteSlots(input, input.slots ?? {}) : { ...(input.slots ?? {}) };
  const fields = fieldsForKind(kind, input.sources);
  const questions: string[] = [];
  if (kind === "unknown") questions.push("这是要报价、建样品，还是建客户？");
  if (kind === "quote") questions.push(...quoteQuestions(slots));
  for (const label of requiredMissing(fields)) questions.push(`请补充${label}`);
  if (input.sources.some((source) => source.ocrStatus === "FAILED")) {
    questions.push("有附件没识别出来，请逐字段补录（未识别的字段已留空）");
  }
  const tasks = tasksFor(kind, input.sources);
  const summary = summarize(kind, fields, slots, questions);
  return IntentUnderstanding.parse({
    kind,
    summary,
    slots,
    pendingQuestions: [...new Set(questions)].slice(0, 20),
    fields,
    tasks,
  });
}

/**
 * 纠正理解：只改 kind / slots / 字段值，不执行。
 * 用户改过的字段变成 EDITED；清空值则回到 PENDING（不是「确认了一个空值」）。
 */
export function reviseUnderstanding(
  current: Understanding,
  input: {
    kind?: IntentKind;
    slots?: Record<string, JsonValue>;
    fields?: Array<{ fieldName: string; value: JsonValue | null }>;
  },
  sources: InboundSourceInsight[],
): Understanding {
  const nextKind = input.kind && input.kind !== "unknown" ? input.kind : current.kind;
  const slots = { ...current.slots, ...(input.slots ?? {}) };
  for (const [key, value] of Object.entries(input.slots ?? {})) {
    if (value === null || value === "") delete slots[key];
  }

  let fields = current.fields;
  if (nextKind !== current.kind) {
    // kind 换了就是另一类业务：客户名不能顺手变成样品品名。
    // 按新 kind 重建字段骨架，用户重新确认/补录（已填的值不跨类型搬运）。
    fields = fieldsForKind(nextKind, sources);
  }

  const edits = new Map((input.fields ?? []).map((entry) => [entry.fieldName, entry.value]));
  fields = fields.map((card) => {
    if (!edits.has(card.fieldName)) return card;
    const value = edits.get(card.fieldName) ?? "";
    const text = asText(value);
    return {
      ...card,
      value: value ?? "",
      status: text.length === 0 ? "PENDING" : "EDITED",
      pending: text.length === 0,
      // 用户主动填的值是人工录入，不再声称来自 OCR。
      sourceKind: "manual",
      sourceId: null,
    } satisfies InboundFieldCard;
  });
  // 新 kind 需要的字段可能在旧卡里完全不存在：补一行空字段，UI 才有输入框。
  for (const card of fieldsForKind(nextKind, sources)) {
    if (!fields.some((entry) => entry.fieldName === card.fieldName)) fields.push(card);
  }

  const questions: string[] = [];
  if (nextKind === "unknown") questions.push("这是要报价、建样品，还是建客户？");
  if (nextKind === "quote") questions.push(...quoteQuestions(slots));
  for (const label of requiredMissing(fields)) questions.push(`请补充${label}`);
  const tasks = tasksFor(nextKind, sources).map((task) => {
    if (task.kind === "quote" && nextKind === "quote") return task;
    return task;
  });
  return IntentUnderstanding.parse({
    kind: nextKind,
    summary: summarize(nextKind, fields, slots, questions),
    slots,
    pendingQuestions: [...new Set(questions)].slice(0, 20),
    fields,
    tasks,
  });
}

/** 执行前的最后一道门：kind 明确、必需字段有值。 */
export function inboundReadiness(understanding: Understanding): {
  ready: boolean;
  reason: string | null;
} {
  if (understanding.kind === "unknown") {
    return { ready: false, reason: "还没判断出这是报价、建样品还是建客户" };
  }
  const missing = requiredMissing(understanding.fields);
  if (understanding.kind !== "quote" && missing.length > 0) {
    return { ready: false, reason: `还差：${missing.join("、")}` };
  }
  if (understanding.kind === "quote") {
    const questions = quoteQuestions(understanding.slots);
    // 报价允许交给 agent 补问；只有完全没线索时才算「还没准备好」。
    if (questions.length === 3) {
      return { ready: false, reason: "报价还缺客户、样品与数量" };
    }
  }
  return { ready: true, reason: null };
}

/** 字段值 → 草稿字段（只传有值的；空值不写，避免把「未识别」写成空字符串）。 */
export function draftFieldsOf(understanding: Understanding): Array<{
  fieldName: string;
  value: JsonValue;
  sourceKind: ResourceFieldSourceKind;
  sourceId: string | null;
}> {
  return understanding.fields
    .filter((card) => asText(card.value).length > 0)
    .filter((card) =>
      [
        "name",
        "contactName",
        "title",
        "contactPhone",
        "contactEmail",
        "address",
        "business",
        "composition",
        "weight",
        "width",
        "lot",
        "supplier",
      ].includes(card.fieldName),
    )
    .map((card) => ({
      fieldName: card.fieldName,
      value: card.value,
      sourceKind: card.sourceKind,
      sourceId: card.sourceId,
    }));
}
