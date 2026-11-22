import { z } from "zod";

/**
 * 可自定义字段（字段选项）的唯一契约来源。
 *
 * 三个消费方（表单组合框 / CSV 导入 / 智能体工具）必须共用同一套归一化与解析规则：
 * 各写一份必然漂移，表现为「用户手输 `POLYESTER` 能匹配、导入同一份 CSV 却新建了一条」。
 * 本文件只放纯函数与纯数据，不依赖数据库与运行环境，前后端同包引用。
 */

/**
 * 走 `field_options` 的字段。新增字段只加这里一行，不在调用点判断字符串。
 *
 * - `customer.tier`：客户等级，`customers.tier` 存 `code`（code 引用）。
 * - `sample.category` / `sample.composition` / `sample.color`：样品品类/成分/颜色，业务表仍存原文，选项只是建议。
 * - `sample.material`：样品原料（配比模式用的原料字典），按 code 引用进 `composition_parts`。
 * - `contact.role`：联系人角色，同「只做建议」。
 */
export const FIELD_KEYS = [
  "customer.tier",
  "sample.category",
  "sample.composition",
  "sample.color",
  "sample.material",
  "contact.role",
] as const;
export const FieldKey = z.enum(FIELD_KEYS);
export type FieldKey = z.infer<typeof FieldKey>;

/** 字段选项读模型（P1 的 API 直接返回这个形状）。 */
export const FieldOption = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    fieldKey: FieldKey,
    /** 稳定标识：配置后不再变化；即使改名也只改 label。 */
    code: z.string().min(1).max(64),
    label: z.string().min(1).max(128),
    /** 由 `normalizeFieldValue(label)` 派生，唯一性由数据库约束兜底。 */
    normalized: z.string().min(1).max(128),
    sortOrder: z.number().int(),
    /** 软删除：false 表示已停用（仍可被历史数据解析，只是不再出现在下拉里）。 */
    active: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type FieldOption = z.infer<typeof FieldOption>;

/** 解析结果：命中时给稳定 code，未命中 `code` 为 null（由调用方决定新建/放弃）。 */
export interface FieldResolution {
  fieldKey: FieldKey;
  /** 用户/导入/智能体给的原始值，原样返回便于回显。 */
  input: string;
  normalized: string;
  matched: boolean;
  code: string | null;
  label: string | null;
}

/** 解析时只关心这三列；传入完整选项行也满足该形状。 */
export interface FieldOptionLike {
  fieldKey: FieldKey;
  code: string;
  label: string;
  normalized: string;
  active?: boolean;
}

/**
 * 归一化：NFKC（全角转半角）→ 去首尾空白 → 连续空白折叠为一个空格 → 拉丁字母小写。
 *
 * 为什么必须 NFKC：中文输入法下 `Ａ`（全角）与 `A` 肉眼几乎无差，用户会两边都输；
 * 不做 NFKC 就会出现两条「同名」选项。只小写拉丁字母（不碰西里尔/日文假名），
 * 避免把 `СПБ` 这类非拉丁值改得看起来像另一个值。
 */
export function normalizeFieldValue(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[A-Z\u00C0-\u00D6\u00D8-\u00DE]/g, (char) => char.toLowerCase());
}

/**
 * 把用户输入解析到已有选项（纯函数，不查库）。
 *
 * 只按 `normalized` 精确匹配，不做模糊/包含匹配：模糊匹配会把「棉」错配到「棉混纺」，
 * 而选项错误的代价是历史报表口径被悄悄改掉。未命中由调用方决定是否新建。
 * 默认只看 `active !== false` 的选项；需要解析历史停用值时显式传 `includeInactive`。
 */
export function resolveFieldValue(
  field: FieldKey,
  value: string,
  options: readonly FieldOptionLike[],
  includeInactive = false,
): FieldResolution {
  const input = value;
  const normalized = normalizeFieldValue(value);
  const hit = options.find(
    (option) =>
      option.fieldKey === field &&
      (includeInactive || option.active !== false) &&
      // 等级这类 code 引用字段：用户/CSV/智能体给的往往是 code（NEW、VIP），
      // 文本字段给的是 label。两者都归一化后比较，才能共用同一个解析入口。
      (option.normalized === normalized || normalizeFieldValue(option.code) === normalized),
  );
  return {
    fieldKey: field,
    input,
    normalized,
    matched: hit !== undefined,
    code: hit?.code ?? null,
    label: hit?.label ?? null,
  };
}

/** 等级预置项：code 沿用旧枚举值，存量客户零改动即可继续解析。 */
export const DEFAULT_TIER_OPTIONS: ReadonlyArray<{
  code: string;
  label: string;
  sortOrder: number;
}> = [
  { code: "NEW", label: "新客", sortOrder: 10 },
  { code: "REGULAR", label: "常规", sortOrder: 20 },
  { code: "VIP", label: "VIP", sortOrder: 30 },
  { code: "COLD", label: "沉睡", sortOrder: 40 },
];

/**
 * 自定义等级的 code：`T-` + 随机段。
 *
 * 不用 `LEVEL_5` 这类名字，是因为顺序由用户拖拽维护，code 里带数字会让「改名」和
 * 「排序」看起来互相矛盾；`T-` 前缀也保证不会与沿用旧枚举的四个预置 code 相撞。
 */
export function generateTierCode(random: () => string = defaultRandomSegment): string {
  return `T-${random()}`;
}

function defaultRandomSegment(): string {
  // 12 位 base36：约 4.7e18 组合，租户内碰撞概率可忽略；唯一约束仍兜底。
  return (
    Math.random().toString(36).slice(2, 8).toUpperCase() +
    Date.now().toString(36).slice(-6).toUpperCase()
  );
}

/**
 * 非等级字段（品类/成分/联系人角色）的稳定 code。
 *
 * 与等级不同，这些字段业务表存的是原文，`code` 只用于治理页与合并定位。
 * 用随机段而不是 label：改名后旧 label 不应继续被当成「同一选项」的别名，
 * 否则用户手输历史名字会被悄悄解析到新选项上，历史统计口径就变了。
 */
export function generateOptionCode(random: () => string = defaultRandomSegment): string {
  return `O-${random()}`;
}

/**
 * 新公司建租户时写入的预置选项（四个字段）。
 *
 * 预置项与用户新增项完全平等：可改名、可删除、可排序，没有任何不可改的内置项。
 * 幂等写入由 `(tenant_id, field_key, normalized)` / `code` 唯一约束兜底。
 */
export const DEFAULT_FIELD_OPTIONS: Readonly<
  Record<FieldKey, ReadonlyArray<{ code: string; label: string; sortOrder: number }>>
> = {
  "customer.tier": DEFAULT_TIER_OPTIONS,
  "sample.category": [
    { code: "CAT-KNIT", label: "针织", sortOrder: 10 },
    { code: "CAT-WOVEN", label: "梭织", sortOrder: 20 },
    { code: "CAT-NONWOVEN", label: "无纺", sortOrder: 30 },
    { code: "CAT-YARNDYE", label: "色织", sortOrder: 40 },
    { code: "CAT-PRINT", label: "印花", sortOrder: 50 },
  ],
  "sample.composition": [
    { code: "COMP-COTTON", label: "100% 棉", sortOrder: 10 },
    { code: "COMP-POLYESTER", label: "100% 涤纶", sortOrder: 20 },
    { code: "COMP-COTTON-POLY", label: "棉涤混纺", sortOrder: 30 },
    { code: "COMP-LINEN", label: "100% 亚麻", sortOrder: 40 },
    { code: "COMP-SILK", label: "100% 真丝", sortOrder: 50 },
  ],
  "sample.material": [
    { code: "MAT-COTTON", label: "棉", sortOrder: 10 },
    { code: "MAT-POLYESTER", label: "涤纶", sortOrder: 20 },
    { code: "MAT-NYLON", label: "锦纶", sortOrder: 30 },
    { code: "MAT-ACRYLIC", label: "腈纶", sortOrder: 40 },
    { code: "MAT-VISCOSE", label: "粘胶", sortOrder: 50 },
    { code: "MAT-MODAL", label: "莫代尔", sortOrder: 60 },
    { code: "MAT-LYOCELL", label: "莱赛尔", sortOrder: 70 },
    { code: "MAT-CUPPRO", label: "铜氨", sortOrder: 80 },
    { code: "MAT-ACETATE", label: "醋酸", sortOrder: 90 },
    { code: "MAT-SPANDEX", label: "氨纶", sortOrder: 100 },
    { code: "MAT-LINEN", label: "亚麻", sortOrder: 110 },
    { code: "MAT-RAMIE", label: "苎麻", sortOrder: 120 },
    { code: "MAT-JUTE", label: "黄麻", sortOrder: 130 },
    { code: "MAT-SILK", label: "真丝", sortOrder: 140 },
    { code: "MAT-WOOL", label: "羊毛", sortOrder: 150 },
    { code: "MAT-CASHMERE", label: "羊绒", sortOrder: 160 },
    { code: "MAT-BAMBOO", label: "竹纤维", sortOrder: 170 },
    { code: "MAT-RAYON", label: "人造丝", sortOrder: 180 },
  ],
  "sample.color": [
    { code: "COLOR-BLACK", label: "黑色", sortOrder: 10 },
    { code: "COLOR-WHITE", label: "白色", sortOrder: 20 },
    { code: "COLOR-NAVY", label: "藏青", sortOrder: 30 },
    { code: "COLOR-GREY", label: "灰色", sortOrder: 40 },
    { code: "COLOR-BEIGE", label: "米白", sortOrder: 50 },
    { code: "COLOR-KHAKI", label: "卡其", sortOrder: 60 },
    { code: "COLOR-BLUE", label: "蓝色", sortOrder: 70 },
    { code: "COLOR-RED", label: "红色", sortOrder: 80 },
  ],
  "contact.role": [
    { code: "ROLE-PURCHASING", label: "采购", sortOrder: 10 },
    { code: "ROLE-FINANCE", label: "财务", sortOrder: 20 },
    { code: "ROLE-MERCHANDISER", label: "跟单", sortOrder: 30 },
  ],
};

/** 治理页每一行的读模型：选项 + 实际用量。 */
export const FieldOptionWithUsage = FieldOption.extend({
  /** 正在使用该选项的业务记录数；等级按 code，品类/成分按归一化后的原文。 */
  usage: z.number().int().min(0),
}).strict();
export type FieldOptionWithUsage = z.infer<typeof FieldOptionWithUsage>;

export const FieldOptionListResponse = z
  .object({ options: z.array(FieldOptionWithUsage) })
  .strict();
export type FieldOptionListResponse = z.infer<typeof FieldOptionListResponse>;

export const CreateFieldOptionInput = z
  .object({
    fieldKey: FieldKey,
    label: z.string().trim().min(1).max(128),
  })
  .strict();
export type CreateFieldOptionInput = z.infer<typeof CreateFieldOptionInput>;

export const RenameFieldOptionInput = z
  .object({
    label: z.string().trim().min(1).max(128),
  })
  .strict();
export type RenameFieldOptionInput = z.infer<typeof RenameFieldOptionInput>;

export const ReorderFieldOptionsInput = z
  .object({
    fieldKey: FieldKey,
    /** 全量顺序：必须覆盖该字段全部选项，少传或多传都拒绝，避免半截排序。 */
    ids: z.array(z.string().uuid()).min(1),
  })
  .strict();
export type ReorderFieldOptionsInput = z.infer<typeof ReorderFieldOptionsInput>;

export const MergeFieldOptionsInput = z
  .object({
    sourceId: z.string().uuid(),
    targetId: z.string().uuid(),
    /**
     * 纯文本字段（品类/成分/联系人角色）是否改写历史原文。
     * 等级永远回写 code，无需该开关；为 false 时只停用 source，不动业务数据。
     */
    rewriteText: z.boolean().default(true),
  })
  .strict();
export type MergeFieldOptionsInput = z.infer<typeof MergeFieldOptionsInput>;

/** 合并前的预览：条数 + 前几条样例，用户确认后才会真正改数据。 */
export const FieldOptionMergePreview = z
  .object({
    fieldKey: FieldKey,
    source: FieldOption,
    target: FieldOption,
    affected: z.number().int().min(0),
    samples: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
      }),
    ),
  })
  .strict();
export type FieldOptionMergePreview = z.infer<typeof FieldOptionMergePreview>;

export const MergeFieldOptionsResult = z.object({ affected: z.number().int().min(0) }).strict();
export type MergeFieldOptionsResult = z.infer<typeof MergeFieldOptionsResult>;

export const ResolveFieldValueResponse = z
  .object({
    fieldKey: FieldKey,
    input: z.string(),
    normalized: z.string(),
    matched: z.boolean(),
    code: z.string().nullable(),
    label: z.string().nullable(),
  })
  .strict();
export type ResolveFieldValueResponse = z.infer<typeof ResolveFieldValueResponse>;
