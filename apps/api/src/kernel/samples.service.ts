import { fieldOptions, samples } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import {
  CreateSampleInput,
  CreateSampleDraftInput,
  SAMPLE_FILTER_TIER_LIMIT,
  SampleDraftResponse,
  UpdateSampleInput,
  WeightMeasurement,
  WeightUnit,
  WidthMeasurement,
  WidthUnit,
  hasCapability,
  isSampleStatusAvailable,
  normalizeFieldValue,
  weightGsmOf,
  weightMeasurementFrom,
  weightSearchText,
  widthCmOf,
  widthMeasurementFrom,
} from "@weave-order/schema";
import type {
  CompositionParts,
  DraftFieldInput,
  FabricSample,
  JsonValue,
  MemberRole,
  SampleStatus,
} from "@weave-order/schema";
import { and, asc, count, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { CodeNumberService } from "./code-number.service";
import { decodeCursor, encodeCursor, invalidCursor } from "./cursor";
import { KernelError, isUniqueViolation, uniqueViolationConstraint } from "./errors";
import { mayViewCost, toIso } from "./mappers";
import { SampleImageService } from "./sample-images.service";
import type { EmbeddingProvider } from "../platform/embedding";
import { SampleIndexService } from "./sample-index.service";
import type { ImageIndexService } from "./image-index.service";
import type { SampleThumbService } from "./sample-thumbs.service";
import { escapeLikePattern } from "./like";
import type { ResourceFieldService } from "./resource-fields.service";
import type { CompositionService } from "./composition.service";

type SampleRow = typeof samples.$inferSelect;

/**
 * 样品写权限（sales / viewer / 财务 / 跟单只读）。
 * 规则本身在 `@weave-order/schema` 的 `sample.write`，这里只保留调用形状。
 * 无角色（系统任务 / 智能体内核路径）视为可写；角色裁剪只发生在人类请求上。
 */
export function mayWriteSamples(role?: MemberRole): boolean {
  if (!role) return true;
  return hasCapability(role, "sample.write");
}

function assertCanWriteSamples(ctx: KernelContext): void {
  if (!mayWriteSamples(ctx.actor.role)) {
    throw new KernelError(
      "PERMISSION_DENIED",
      "当前角色没有样品写权限（需要样品管理员 / 经理 / 老板）",
    );
  }
}

/**
 * 防「读不到却写回」：如果角色看不到成本底线，编辑器手里只有 null，
 * 任何带 costFloor 的写请求都显式拒绝，而不是把原值静默清空。
 */
function assertCostFloorWritable(costFloor: unknown, ctx: KernelContext): void {
  if (costFloor !== undefined && !mayViewCost(ctx.actor.role)) {
    throw new KernelError("PERMISSION_DENIED", "当前角色不能修改不可见的成本底线");
  }
}

/** 行 → 克重（数值 + 单位）；单位列是 varchar，非法单位读成 null 而不是假装合法。 */
function weightMeasurementOf(row: SampleRow): WeightMeasurement | null {
  return weightMeasurementFrom(row.weightValue, row.weightUnit);
}

/** 行 → 门幅（数值 + 单位）。 */
function widthMeasurementOf(row: SampleRow): WidthMeasurement | null {
  return widthMeasurementFrom(row.widthValue, row.widthUnit);
}

/**
 * 克重 → 列。
 *
 * 归一列（g/m²）与检索文本都在这里派生：写入侧只有这一个入口，
 * 筛选、找样与录入口径才不会各算各的。
 */
function weightColumns(measurement: WeightMeasurement | null): {
  weightValue: number | null;
  weightUnit: WeightUnit | null;
  weightGsm: number | null;
  weightText: string | null;
} {
  if (!measurement) {
    return { weightValue: null, weightUnit: null, weightGsm: null, weightText: null };
  }
  return {
    weightValue: measurement.value,
    weightUnit: measurement.unit,
    weightGsm: weightGsmOf(measurement),
    weightText: weightSearchText(measurement),
  };
}

/** 门幅 → 列（归一 cm）。 */
function widthColumns(measurement: WidthMeasurement | null): {
  widthValue: number | null;
  widthUnit: WidthUnit | null;
  widthCm: number | null;
} {
  if (!measurement) {
    return { widthValue: null, widthUnit: null, widthCm: null };
  }
  return {
    widthValue: measurement.value,
    widthUnit: measurement.unit,
    widthCm: widthCmOf(measurement),
  };
}

/** 克重 → 检索文本；空值给 null（不是空串）。 */
function weightSearchTextOrNull(measurement: WeightMeasurement | null | undefined): string | null {
  return measurement ? weightSearchText(measurement) : null;
}

/**
 * 成分落库形态：文本与配比互斥，只有一边为真。
 *
 * - 给了配比 → 服务端派生文本（客户端写的文本不作数，避免两份口径漂移）；
 * - 只给文本 → 文本模式，配比清空。
 */
export interface CompositionColumns {
  composition: string | null;
  compositionParts: CompositionParts | null;
}

/**
 * 成分在字段矩阵里的取值。
 *
 * 文本模式是原文，配比模式是明细对象 —— 与主表同构，
 * 确认页拿到值就能显示，不必再猜一次「这是文本还是配比」。
 */
export function compositionValue(columns: CompositionColumns): JsonValue | null {
  if (columns.compositionParts) {
    return { parts: columns.compositionParts.map((part) => ({ ...part })) };
  }
  return columns.composition;
}

export function mapSample(row: SampleRow): FabricSample {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    composition: row.composition,
    compositionParts: row.compositionParts ?? null,
    category: row.category,
    color: row.color,
    weight: weightMeasurementOf(row),
    width: widthMeasurementOf(row),
    weightGsm: row.weightGsm,
    widthCm: row.widthCm,
    unit: row.unit,
    costFloor:
      row.costFloorAmount === null || row.costFloorCurrency === null
        ? null
        : { amount: row.costFloorAmount, currency: row.costFloorCurrency },
    status: row.status,
    // 图片由控制器按 `sample_images` 补齐；列表/详情接口都会覆盖这两个字段。
    images: [],
    primaryImageUrl: null,
    createdAt: toIso(row.createdAt),
  };
}

/**
 * 面向人的样品读模型：按角色裁剪成本底线。
 * 内核内部（计价、工具层）继续用 mapSample 拿到完整底线，裁剪只在这一层发生。
 */
export function presentSample(row: SampleRow, role?: MemberRole): FabricSample {
  const sample = mapSample(row);
  if (mayViewCost(role)) return sample;
  // 契约里 costFloor 是必填可空字段：裁剪后给 null，前端语义等同「不可见/未设置」。
  return { ...sample, costFloor: null };
}

/** 样品编号前缀：`S` + 北京时间 `YYMMDD` + `-`，与客户编号同一条时区纪律。 */
export function sampleCodePrefix(now: Date = new Date()): string {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const yy = String(beijing.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(beijing.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(beijing.getUTCDate()).padStart(2, "0");
  return `S${yy}${mm}${dd}-`;
}

export interface SampleListFilters {
  query?: string | null;
  category?: string | null;
  /** 成分子串（`ILIKE`，已由 HTTP 层 trim 并限制长度）。 */
  composition?: string | null;
  /** 克重档位检索文本，精确匹配 `samples.weight_text`。 */
  weights?: string[] | null;
  /** 颜色原文，精确匹配 `samples.color`。 */
  colors?: string[] | null;
  /** 克重区间（g/m²，闭区间），只命中有归一克重的样品。 */
  weightGsmMin?: number | null;
  weightGsmMax?: number | null;
  status?: SampleStatus | "ALL" | null;
  cursor?: string | null;
  limit?: number;
}

export interface SamplePage {
  samples: FabricSample[];
  nextCursor: string | null;
  hasMore: boolean;
  /** 当前筛选条件下的总数（用于「共 N 个」）。 */
  total: number;
  /** 本页之后还剩多少个，用于「还有 N 个」。 */
  remaining: number;
  /** 当前租户已有的品类，给筛选器做选项。 */
  categories: string[];
  /** 成分选项：真实数据里的非空值，按出现次数倒序。 */
  compositions: string[];
  /** 克重档位选项：真实数据里的非空原文，按出现次数倒序。 */
  weights: string[];
  /** 颜色选项：`field_options` 的 `sample.color` 选项 + 存量原文里未入选项的值。 */
  colors: string[];
  /** 克重区间边界：当前筛选状态下的 `min/max(weight_gsm)`；无数据时为 null。 */
  weightGsmRange: { min: number; max: number } | null;
}

type SamplePageCursor = { createdAt: string; id: string };

function parseSampleCursor(raw: string | null | undefined): SamplePageCursor | null {
  const decoded = decodeCursor(raw);
  if (!decoded) return null;
  const { createdAt, id } = decoded;
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw invalidCursor();
  if (typeof id !== "string" || id.length === 0) throw invalidCursor();
  return { createdAt, id };
}

/** 与 approvals 一致的 keyset 条件：按 `createdAt DESC, id DESC` 取严格更小的键。 */
function afterCursor(cursor: SamplePageCursor) {
  const createdAt = new Date(cursor.createdAt);
  return or(
    lt(samples.createdAt, createdAt),
    and(eq(samples.createdAt, createdAt), lt(samples.id, cursor.id)),
  );
}

/** 样品内核服务：samples 的唯一写入入口。 */
export class SampleService {
  /** 编号生成服务；未注入时按自身 db/tenantId 构造（兼容老单测的直接 new）。 */
  private readonly codeNumber: CodeNumberService;

  constructor(
    private readonly db: Db,
    private readonly embedder: EmbeddingProvider,
    private readonly tenantId: string,
    private readonly images: SampleImageService = new SampleImageService(db, tenantId),
    private readonly index: SampleIndexService = new SampleIndexService(db, embedder, tenantId),
    /** 图像向量索引；未注入时（老单测）跳过图片索引，不静默假装已索引。 */
    private readonly imageIndex?: ImageIndexService,
    /** 持久化缩略图；未注入时（老单测）跳过派生，图墙按 `thumb_status` 标注。 */
    private readonly thumbs?: SampleThumbService,
    /** 字段出处矩阵；草稿 / 逐字段确认共用。 */
    private readonly resourceFields?: ResourceFieldService,
    codeNumber?: CodeNumberService,
    /** 成分解析：配比 → 文本的派生与原料字典校验都在这里。 */
    private readonly composition?: CompositionService,
  ) {
    this.codeNumber = codeNumber ?? new CodeNumberService(db, tenantId);
  }

  /**
   * 图片写完（提交后）补算图像向量。
   * 失败只落在 `sample_images.index_status` 上，不让「建样品」因为模型抖动而失败；
   * 图墙会显示「索引失败」，随时可用 `reindex:images` 重试。
   */
  private async indexImages(sampleId: string): Promise<void> {
    if (!this.imageIndex) return;
    // 有后台 worker 时只入队（HTTP 响应不等模型）；CLI/单测退回同步，行为确定。
    await this.imageIndex.requestSampleIndex(sampleId);
  }

  /**
   * 图片写完（提交后）派生图墙缩略图。
   * 失败只落在 `thumb_status` 上：建样品不该因为一张图解码失败而回滚，
   * 客户端会看到「缩略图失败」并回退原图。
   */
  private async deriveThumbs(sampleId: string): Promise<void> {
    if (!this.thumbs) return;
    await this.thumbs.deriveForSample(sampleId);
  }

  /**
   * 成分 → 主表两列（文本 + 配比）。
   *
   * 判定只在 `CompositionService` 一处：配比优先、文本由服务端派生；
   * 只给文本就是文本模式，配比清空 —— 两种模式不会同时为真。
   */
  private async compositionColumns(input: {
    composition?: string | null;
    compositionParts?: unknown;
  }): Promise<CompositionColumns> {
    if (!this.composition) {
      // 没有原料字典就认不了配比：宁可明确拒绝，也不把来路不明的原料名写进库。
      if (input.compositionParts !== undefined && input.compositionParts !== null) {
        throw new KernelError("KERNEL_REJECTED", "成分配比暂时不可用，请改用文本录入", {
          reason: "COMPOSITION_UNAVAILABLE",
        });
      }
      return { composition: input.composition ?? null, compositionParts: null };
    }
    return this.composition.resolve({
      text: input.composition ?? null,
      parts: input.compositionParts,
    });
  }

  async create(input: unknown, ctx: KernelContext): Promise<FabricSample> {
    assertCanWriteSamples(ctx);
    const parsed = CreateSampleInput.parse(input);
    assertCostFloorWritable(parsed.costFloor, ctx);
    const imageKeys = parsed.imageKeys ?? [];
    if (parsed.primaryImageKey != null && imageKeys.length === 0) {
      throw new KernelError("KERNEL_REJECTED", "主图必须包含在 imageKeys 里", {
        reason: "SAMPLE_PRIMARY_IMAGE_NOT_IN_LIST",
      });
    }
    // 校验图片与生成向量都在事务前完成：任一失败都不会留下半写入的样品。
    // 模型超时/5xx 会让整个请求失败（显式报错），绝不写入「看起来正常」的哈希分数。
    const resolvedImages = await this.images.resolveKeys(imageKeys);
    // 成分先定稿：配比派生的文本要进向量文本，样卡与检索看到的都是它。
    const composition = await this.compositionColumns({
      composition: parsed.composition,
      compositionParts: parsed.compositionParts,
    });
    const preparedVector = await this.index.prepare({
      code: parsed.code,
      name: parsed.name,
      composition: composition.composition,
      category: parsed.category ?? null,
      color: parsed.color ?? null,
      // 检索文本用规范写法（"220g/m2"），向量文本与检索口径保持同一份。
      weightText: parsed.weight ? weightSearchText(parsed.weight) : null,
    });
    try {
      const row = await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(samples)
          .values({
            tenantId: this.tenantId,
            code: parsed.code,
            name: parsed.name,
            composition: composition.composition,
            compositionParts: composition.compositionParts,
            category: parsed.category ?? null,
            color: parsed.color ?? null,
            ...weightColumns(parsed.weight ?? null),
            ...widthColumns(parsed.width ?? null),
            unit: parsed.unit,
            costFloorAmount: parsed.costFloor?.amount ?? null,
            costFloorCurrency: parsed.costFloor?.currency ?? null,
            status: parsed.status,
          })
          .returning();
        const inserted = rows[0];
        if (!inserted) {
          throw new KernelError("KERNEL_REJECTED", "样品写入未返回记录", {
            reason: "INSERT_RETURNED_NO_ROW",
          });
        }
        if (imageKeys.length > 0) {
          await this.images.replaceWithin(
            tx,
            inserted.id,
            resolvedImages,
            parsed.primaryImageKey ?? null,
          );
        }
        await this.index.writeWithin(tx, inserted.id, preparedVector);
        await appendAudit(
          tx,
          ctx,
          {
            action: "SAMPLE_CREATED",
            entityType: "sample",
            entityId: inserted.id,
            before: null,
            after: {
              code: inserted.code,
              name: inserted.name,
              unit: inserted.unit,
              category: inserted.category,
              costFloorAmount: inserted.costFloorAmount,
              imageCount: imageKeys.length,
            },
          },
          this.tenantId,
        );
        return inserted;
      });
      // 事务外补图向量：模型调用不该拽着数据库事务。
      if (imageKeys.length > 0) await this.indexImages(row.id);
      if (imageKeys.length > 0) await this.deriveThumbs(row.id);
      return mapSample(row);
    } catch (error) {
      if (isUniqueViolation(error) && isSampleCodeConflict(error)) throw sampleCodeExists();
      throw error;
    }
  }

  /**
   * 在外部事务内插入样品 + 向量 + 同事务审计，不自行开事务。
   * 单条 create 与批量导入共用这一处写逻辑。向量不在这里写：批量导入在提交后
   * 由 `reindexTenant` 统一补齐（失败不阻塞导入，但会记审计）。
   *
   * 注意：Excel 导入不带图，所以这里不处理 `imageKeys`（`SampleImportRow` 也不允许填）。
   */
  async insertWithin(tx: Tx, parsed: CreateSampleInput, ctx: KernelContext): Promise<FabricSample> {
    const composition = await this.compositionColumns({
      composition: parsed.composition,
      compositionParts: parsed.compositionParts,
    });
    const rows = await tx
      .insert(samples)
      .values({
        tenantId: this.tenantId,
        code: parsed.code,
        name: parsed.name,
        composition: composition.composition,
        compositionParts: composition.compositionParts,
        category: parsed.category ?? null,
        color: parsed.color ?? null,
        ...weightColumns(parsed.weight ?? null),
        ...widthColumns(parsed.width ?? null),
        unit: parsed.unit,
        costFloorAmount: parsed.costFloor?.amount ?? null,
        costFloorCurrency: parsed.costFloor?.currency ?? null,
        status: parsed.status,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new KernelError("KERNEL_REJECTED", "样品写入未返回记录", {
        reason: "INSERT_RETURNED_NO_ROW",
      });
    }
    await appendAudit(
      tx,
      ctx,
      {
        action: "SAMPLE_CREATED",
        entityType: "sample",
        entityId: row.id,
        before: null,
        after: {
          code: row.code,
          name: row.name,
          unit: row.unit,
          category: row.category,
          costFloorAmount: row.costFloorAmount,
        },
      },
      this.tenantId,
    );
    return mapSample(row);
  }

  /** 部分字段更新；`imageKeys` 提供即为整组替换，主图与图片行同事务落库。 */
  /**
   * 从面料标签/文本建样品草稿（`sourceId` 幂等）。
   *
   * 草稿不写向量索引、不进图墙默认列表：没确认可用之前不该参与找样与历史价取数。
   */
  async createDraft(input: unknown, ctx: KernelContext): Promise<SampleDraftResponse> {
    assertCanWriteSamples(ctx);
    const parsed = CreateSampleDraftInput.parse(input);
    const existing = await this.findByDraftSource(parsed.sourceId);
    if (existing) return this.draftResponse(existing, false);

    try {
      const composition = await this.compositionColumns({
        composition: parsed.composition,
        compositionParts: parsed.compositionParts,
      });
      const row = await this.db.transaction((tx) =>
        this.codeNumber.allocateAndWrite(tx, "sample", new Date(), async (code) => {
          const rows = await tx
            .insert(samples)
            .values({
              tenantId: this.tenantId,
              code,
              name: parsed.name ?? "待确认样品",
              composition: composition.composition,
              compositionParts: composition.compositionParts,
              category: parsed.category ?? null,
              color: parsed.color ?? null,
              ...weightColumns(parsed.weight ?? null),
              ...widthColumns(parsed.width ?? null),
              unit: parsed.unit,
              costFloorAmount: parsed.costFloor?.amount ?? null,
              costFloorCurrency: parsed.costFloor?.currency ?? null,
              status: "DRAFT",
              draftSourceId: parsed.sourceId,
            })
            .returning();
          const inserted = rows[0];
          if (!inserted) {
            throw new KernelError("KERNEL_REJECTED", "样品草稿写入未返回记录", {
              reason: "INSERT_RETURNED_NO_ROW",
            });
          }
          const fields = this.draftFieldInputs(parsed, composition);
          await this.resourceFields?.writeDraftFields(tx, "sample", inserted.id, fields);
          if (!fields.some((field) => field.fieldName === "name")) {
            await this.resourceFields?.markPending(tx, "sample", inserted.id, "name");
          }
          await appendAudit(
            tx,
            ctx,
            {
              action: "SAMPLE_DRAFT_CREATED",
              entityType: "sample",
              entityId: inserted.id,
              before: null,
              after: { sourceId: parsed.sourceId, fieldCount: fields.length },
              entityLabel: inserted.name,
            },
            this.tenantId,
          );
          return inserted;
        }),
      );
      return this.draftResponse(row, true);
    } catch (error) {
      // 草稿幂等键（sourceId）冲突不是撞码：allocateAndWrite 原样冒泡，
      // 命中既有草稿就返回 created=false，与改造前语义一致。
      const duplicate = await this.findByDraftSource(parsed.sourceId);
      if (duplicate) return this.draftResponse(duplicate, false);
      throw error;
    }
  }

  private draftFieldInputs(
    parsed: ReturnType<typeof CreateSampleDraftInput.parse>,
    composition: CompositionColumns,
  ): DraftFieldInput[] {
    const fields: DraftFieldInput[] = [];
    // 克重 / 门幅在矩阵里存「数值 + 单位」这一对（与主表同构），
    // 不是文本：矩阵是逐字段确认的现场，文本会让确认页重新猜一次单位。
    const topLevel: Array<[string, JsonValue | undefined]> = [
      ["name", parsed.name],
      // 成分同理：文本模式存原文，配比模式存结构化明细，确认页不必再猜一次。
      ["composition", compositionValue(composition)],
      ["category", parsed.category],
      ["color", parsed.color],
      ["weight", parsed.weight],
      ["width", parsed.width],
    ];
    for (const [fieldName, value] of topLevel) {
      if (value === undefined || value === null || value === "") continue;
      fields.push({ fieldName, value, sourceKind: "label", sourceId: parsed.sourceId });
    }
    for (const field of parsed.fields ?? []) fields.push(field);
    return fields;
  }

  private async findByDraftSource(sourceId: string): Promise<SampleRow | null> {
    const rows = await this.db
      .select()
      .from(samples)
      .where(and(eq(samples.tenantId, this.tenantId), eq(samples.draftSourceId, sourceId)))
      .limit(1);
    return rows[0] ?? null;
  }

  private async draftResponse(row: SampleRow, created: boolean): Promise<SampleDraftResponse> {
    const fields = this.resourceFields
      ? await this.resourceFields.list(
          "sample",
          row.id,
          row.status === "DRAFT" || row.status === "ARCHIVED" ? row.status : "AVAILABLE",
        )
      : [];
    return SampleDraftResponse.parse({ sample: mapSample(row), created, fields });
  }

  /** 草稿 → 可用；必填字段（名称）未确认时拒绝。 */
  async confirmDraft(sampleId: string, ctx: KernelContext): Promise<FabricSample> {
    assertCanWriteSamples(ctx);
    const before = await this.findRow(sampleId);
    if (isSampleStatusAvailable(before.status)) return presentSample(before, ctx.actor.role);
    if (before.status !== "DRAFT") {
      throw new KernelError("KERNEL_REJECTED", "只有草稿样品可以确认可用", {
        reason: "SAMPLE_NOT_DRAFT",
      });
    }
    await this.resourceFields?.assertRequiredConfirmed("sample", sampleId, ["name"]);
    const row = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(samples)
        .set({ status: "AVAILABLE", updatedAt: new Date() })
        .where(and(eq(samples.id, sampleId), eq(samples.tenantId, this.tenantId)))
        .returning();
      const updated = rows[0];
      if (!updated) {
        throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${sampleId}`, {
          resourceType: "sample",
          resourceId: sampleId,
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "SAMPLE_CONFIRMED",
          entityType: "sample",
          entityId: sampleId,
          before: { status: "DRAFT" },
          after: { status: "AVAILABLE" },
          entityLabel: updated.name,
        },
        this.tenantId,
      );
      return updated;
    });
    // 确认后补建索引：草稿阶段刻意跳过，避免把未确认信息带进找样结果。
    await this.indexImages(sampleId);
    return presentSample(row, ctx.actor.role);
  }

  async update(sampleId: string, input: unknown, ctx: KernelContext): Promise<FabricSample> {
    assertCanWriteSamples(ctx);
    const parsed = UpdateSampleInput.parse(input);
    assertCostFloorWritable(parsed.costFloor, ctx);
    const before = await this.findRow(sampleId);
    const resolvedImages = await resolveUpdateImages(this.images, sampleId, parsed);
    const primaryKey =
      parsed.primaryImageId != null
        ? (await this.images.resolveIds(sampleId, [parsed.primaryImageId]))[0]?.objectKey
        : parsed.primaryImageKey;
    const values: Partial<typeof samples.$inferInsert> = { updatedAt: new Date() };
    if (parsed.code !== undefined) values.code = parsed.code;
    if (parsed.name !== undefined) values.name = parsed.name;
    if (parsed.compositionParts !== undefined) {
      // 配比优先：文本由服务端派生，客户端写的文本不作数（避免两份口径漂移）。
      const composition = await this.compositionColumns({
        composition: parsed.composition,
        compositionParts: parsed.compositionParts,
      });
      values.composition = composition.composition;
      values.compositionParts = composition.compositionParts;
    } else if (parsed.composition !== undefined) {
      // 只给文本就是文本模式：配比一并清空，两种模式不会同时为真。
      values.composition = parsed.composition?.trim() ? parsed.composition.trim() : null;
      values.compositionParts = null;
    }
    if (parsed.category !== undefined) values.category = parsed.category;
    if (parsed.color !== undefined) values.color = parsed.color;
    if (parsed.weight !== undefined) {
      // 克重整对写入：数值、单位、归一 g/m² 与检索文本一起落库，
      // 客户端不能单独写 `weightGsm`，避免两套口径打架。
      Object.assign(values, weightColumns(parsed.weight));
    }
    if (parsed.width !== undefined) {
      Object.assign(values, widthColumns(parsed.width));
    }
    if (parsed.unit !== undefined) values.unit = parsed.unit;
    if (parsed.status !== undefined) values.status = parsed.status;
    if (parsed.costFloor !== undefined) {
      values.costFloorAmount = parsed.costFloor?.amount ?? null;
      values.costFloorCurrency = parsed.costFloor?.currency ?? null;
    }
    // 只有影响向量文本的字段变了才调用模型（改价格/图片不重算）。
    const textChanged =
      (parsed.code !== undefined && parsed.code !== before.code) ||
      (parsed.name !== undefined && parsed.name !== before.name) ||
      // 配比模式的文本是派生出来的，所以比的是落库后的文本，不是客户端写的那个。
      (values.composition !== undefined && values.composition !== before.composition) ||
      (parsed.category !== undefined && (parsed.category ?? null) !== before.category) ||
      (parsed.color !== undefined && (parsed.color ?? null) !== before.color) ||
      (parsed.weight !== undefined &&
        weightSearchTextOrNull(parsed.weight) !== (before.weightText ?? null));
    const preparedVector = textChanged
      ? await this.index.prepare({
          code: parsed.code ?? before.code,
          name: parsed.name ?? before.name,
          composition: values.composition !== undefined ? values.composition : before.composition,
          category: parsed.category ?? before.category,
          color: parsed.color ?? before.color,
          weightText: weightSearchTextOrNull(parsed.weight) ?? before.weightText,
        })
      : null;
    try {
      const row = await this.db.transaction(async (tx) => {
        const rows = await tx
          .update(samples)
          .set(values)
          .where(and(eq(samples.id, sampleId), eq(samples.tenantId, this.tenantId)))
          .returning();
        const updated = rows[0];
        if (!updated) {
          throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${sampleId}`, {
            resourceType: "sample",
            resourceId: sampleId,
          });
        }
        if (resolvedImages) {
          await this.images.replaceWithin(tx, sampleId, resolvedImages, primaryKey ?? null);
        } else if (primaryKey != null) {
          await this.images.setPrimaryWithin(tx, sampleId, primaryKey);
        }
        if (preparedVector) await this.index.writeWithin(tx, sampleId, preparedVector);
        await appendAudit(
          tx,
          ctx,
          {
            action: "SAMPLE_UPDATED",
            entityType: "sample",
            entityId: sampleId,
            before: auditSnapshot(before),
            after: {
              ...auditSnapshot(updated),
              ...(resolvedImages ? { imageCount: resolvedImages.length } : {}),
            },
          },
          this.tenantId,
        );
        return updated;
      });
      if (resolvedImages && resolvedImages.length > 0) await this.indexImages(sampleId);
      if (resolvedImages && resolvedImages.length > 0) await this.deriveThumbs(sampleId);
      return mapSample(row);
    } catch (error) {
      if (isUniqueViolation(error) && isSampleCodeConflict(error)) throw sampleCodeExists();
      throw error;
    }
  }

  /** 软删：只改状态，`sample_images` 行保留（物理删除是 P1 的回收任务）。 */
  async archive(sampleId: string, ctx: KernelContext): Promise<FabricSample> {
    assertCanWriteSamples(ctx);
    const before = await this.findRow(sampleId);
    // 已归档再归档是幂等操作：不重复写审计，也不刷新 updatedAt。
    if (before.status === "ARCHIVED") return presentSample(before, ctx.actor.role);
    const row = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(samples)
        .set({ status: "ARCHIVED", updatedAt: new Date() })
        .where(and(eq(samples.id, sampleId), eq(samples.tenantId, this.tenantId)))
        .returning();
      const updated = rows[0];
      if (!updated) {
        throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${sampleId}`, {
          resourceType: "sample",
          resourceId: sampleId,
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "SAMPLE_ARCHIVED",
          entityType: "sample",
          entityId: sampleId,
          before: auditSnapshot(before),
          after: auditSnapshot(updated),
        },
        this.tenantId,
      );
      return updated;
    });
    return mapSample(row);
  }

  async getById(sampleId: string, role?: MemberRole): Promise<FabricSample> {
    const row = await this.findRow(sampleId);
    return presentSample(row, role);
  }

  /**
   * 单张图的重试：同步重跑缩略图派生与图像向量索引。
   *
   * 与建样品时的 `requestIndex` 刻意不同 —— 用户点了「重试」，必须等到真实结果
   * 再刷新界面，而不是再入队一次让他猜。失败原因已由各 service 落库到
   * `thumb_error` / `index_error`，这里只把「这次是否重跑过」告诉调用方。
   */
  async retryImage(
    sampleId: string,
    imageId: string,
    ctx: KernelContext,
  ): Promise<{ thumbRetried: boolean; indexRetried: boolean }> {
    assertCanWriteSamples(ctx);
    await this.findRow(sampleId);
    const row = (await this.images.listForSample(sampleId)).find((image) => image.id === imageId);
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `图片不属于该样品：${imageId}`, {
        resourceType: "sample_image",
        resourceId: imageId,
      });
    }

    let thumbRetried = false;
    if (this.thumbs && (row.thumbStatus !== "ready" || !row.thumb320Key || !row.thumb640Key)) {
      thumbRetried = true;
      // 失败会重新落 `thumb_status=failed`；抛错不阻断索引重试。
      await this.thumbs
        .derive(imageId, { force: row.thumbStatus !== "ready" })
        .catch(() => undefined);
    }

    let indexRetried = false;
    if (this.imageIndex && row.indexStatus !== "ready") {
      indexRetried = true;
      await this.imageIndex.indexImage(imageId).catch(() => undefined);
    }
    return { thumbRetried, indexRetried };
  }

  /** 游标分页的样品图墙查询；不做 `limit 100` 硬截断。 */
  /**
   * 状态筛选收敛：
   * - `ACTIVE` 是历史别名，与 `AVAILABLE` 一起当「可用」；
   * - `ALL` 不过滤；
   * - `DRAFT` 只有明确点名时才出现（草稿不参与默认找样）。
   */
  private statusCondition(status: SampleStatus | "ALL") {
    if (status === "ALL") return null;
    if (status === "ACTIVE" || status === "AVAILABLE") {
      return inArray(samples.status, ["ACTIVE", "AVAILABLE"]);
    }
    return eq(samples.status, status);
  }

  async listPage(filters: SampleListFilters = {}, ctx?: KernelContext): Promise<SamplePage> {
    const limit = clampLimit(filters.limit, 24, 100);
    const conditions = [eq(samples.tenantId, this.tenantId)];
    const status = filters.status ?? "AVAILABLE";
    const statusWhere = this.statusCondition(status);
    if (statusWhere) conditions.push(statusWhere);
    if (filters.category) conditions.push(eq(samples.category, filters.category));
    if (filters.composition) {
      const pattern = `%${escapeLikePattern(filters.composition.trim())}%`;
      const literal = sql`${pattern} ESCAPE '\\'`;
      conditions.push(sql`${samples.composition} ILIKE ${literal}`);
    }
    if (filters.weights && filters.weights.length > 0) {
      conditions.push(inArray(samples.weightText, filters.weights));
    }
    if (filters.colors && filters.colors.length > 0) {
      conditions.push(inArray(samples.color, filters.colors));
    }
    if (filters.weightGsmMin != null && filters.weightGsmMax != null) {
      if (filters.weightGsmMin > filters.weightGsmMax) {
        throw new KernelError("KERNEL_REJECTED", "克重下限不能大于上限", {
          reason: "SAMPLE_WEIGHT_RANGE_INVALID",
        });
      }
    }
    if (filters.weightGsmMin != null) conditions.push(gte(samples.weightGsm, filters.weightGsmMin));
    if (filters.weightGsmMax != null) conditions.push(lte(samples.weightGsm, filters.weightGsmMax));
    if (filters.query) {
      const pattern = `%${escapeLikePattern(filters.query.trim())}%`;
      const literal = sql`${pattern} ESCAPE '\\'`;
      conditions.push(
        or(
          sql`${samples.code} ILIKE ${literal}`,
          sql`${samples.name} ILIKE ${literal}`,
          sql`${samples.composition} ILIKE ${literal}`,
        )!,
      );
    }
    const baseWhere = and(...conditions);
    const cursor = parseSampleCursor(filters.cursor);
    const pageWhere = cursor ? and(baseWhere, afterCursor(cursor)) : baseWhere;

    // 多取一条判断是否还有下一页，避免额外 count 查询。
    const rows = await this.db
      .select()
      .from(samples)
      .where(pageWhere)
      .orderBy(desc(samples.createdAt), desc(samples.id))
      .limit(limit + 1);
    const pageRows = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ createdAt: toIso(last.createdAt), id: last.id }) : null;

    const totalRows = await this.db.select({ value: count() }).from(samples).where(baseWhere);
    const total = Number(totalRows[0]?.value ?? 0);
    const remainingRows = last
      ? await this.db
          .select({ value: count() })
          .from(samples)
          .where(and(baseWhere, afterCursor({ createdAt: toIso(last.createdAt), id: last.id })))
      : [];
    const remaining = Number(remainingRows[0]?.value ?? 0);

    // 品类选项跟随状态筛选：否则只存在于归档样品里的品类会出现在「在售」筛选器，
    // 选中后列表为空，看起来像 bug。
    const categoryConditions = [eq(samples.tenantId, this.tenantId)];
    const categoryStatusWhere = this.statusCondition(status);
    if (categoryStatusWhere) categoryConditions.push(categoryStatusWhere);
    const categoryRows = await this.db
      .selectDistinct({ category: samples.category })
      .from(samples)
      .where(and(...categoryConditions, sql`${samples.category} IS NOT NULL`))
      .orderBy(asc(samples.category));
    const categories = categoryRows
      .map((entry) => entry.category)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    // 档位选项不跟随 query / category / composition / weights：选中一个 chip 不能
    // 让它自己从选项里消失。只跟随租户 + 状态，与 categories 的已知行为一致。
    const [compositions, weights, colors, weightGsmRange] = await Promise.all([
      this.listTierOptions(samples.composition, status),
      this.listTierOptions(samples.weightText, status),
      this.listColorOptions(status),
      this.weightGsmRange(status),
    ]);

    return {
      samples: pageRows.map((row) => presentSample(row, ctx?.actor.role)),
      nextCursor,
      hasMore,
      total,
      remaining,
      categories,
      compositions,
      weights,
      colors,
      weightGsmRange,
    };
  }

  /**
   * 颜色可选项：先取治理页里启用的 `sample.color` 选项（用户配过的顺序），
   * 再补上存量原文里还没入选项的颜色 —— 导入的历史值不能因为没建选项就选不到。
   * 归一化去重，与表单/导入共用同一套 `normalizeFieldValue` 口径。
   */
  private async listColorOptions(status: SampleStatus | "ALL"): Promise<string[]> {
    const conditions = [
      eq(samples.tenantId, this.tenantId),
      sql`${samples.color} IS NOT NULL`,
      sql`btrim(${samples.color}) <> ''`,
    ];
    const statusWhere = this.statusCondition(status);
    if (statusWhere) conditions.push(statusWhere);
    const [optionRows, valueRows] = await Promise.all([
      this.db
        .select({ label: fieldOptions.label })
        .from(fieldOptions)
        .where(
          and(
            eq(fieldOptions.tenantId, this.tenantId),
            eq(fieldOptions.fieldKey, "sample.color"),
            eq(fieldOptions.active, true),
          ),
        )
        .orderBy(asc(fieldOptions.sortOrder), asc(fieldOptions.createdAt)),
      this.db
        .selectDistinct({ value: samples.color })
        .from(samples)
        .where(and(...conditions))
        .orderBy(asc(samples.color)),
    ]);
    const seen = new Set<string>();
    const colors: string[] = [];
    for (const entry of [
      ...optionRows.map((row) => row.label),
      ...valueRows.map((row) => row.value),
    ]) {
      if (typeof entry !== "string" || entry.trim() === "") continue;
      const key = normalizeFieldValue(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      colors.push(entry);
    }
    return colors;
  }

  /** 克重区间边界：只统计解析出 `weight_gsm` 的可用样品。 */
  private async weightGsmRange(
    status: SampleStatus | "ALL",
  ): Promise<{ min: number; max: number } | null> {
    const conditions = [eq(samples.tenantId, this.tenantId), sql`${samples.weightGsm} IS NOT NULL`];
    const statusWhere = this.statusCondition(status);
    if (statusWhere) conditions.push(statusWhere);
    const rows = await this.db
      .select({
        min: sql<number | null>`min(${samples.weightGsm})`,
        max: sql<number | null>`max(${samples.weightGsm})`,
      })
      .from(samples)
      .where(and(...conditions));
    const row = rows[0];
    if (!row || row.min === null || row.max === null) return null;
    return { min: Number(row.min), max: Number(row.max) };
  }

  /**
   * 某个文本列的真实取值档位：非空、按出现次数倒序、同次数按字面升序。
   * 返回原文而不是 trim 后的值 —— `weights` 要用它做精确 `IN`，改写会选出空结果。
   */
  private async listTierOptions(
    column: typeof samples.composition | typeof samples.weightText,
    status: SampleStatus | "ALL",
  ): Promise<string[]> {
    const conditions = [
      eq(samples.tenantId, this.tenantId),
      sql`${column} IS NOT NULL`,
      sql`btrim(${column}) <> ''`,
    ];
    const statusWhere = this.statusCondition(status);
    if (statusWhere) conditions.push(statusWhere);
    const rows = await this.db
      .select({ value: column, occurrences: count() })
      .from(samples)
      .where(and(...conditions))
      .groupBy(column)
      .orderBy(desc(count()), asc(column))
      .limit(SAMPLE_FILTER_TIER_LIMIT);
    return rows
      .map((entry) => entry.value)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
  }

  /** 工具内部使用：按 ID 批量取样品。 */
  async getManyByIds(sampleIds: string[]): Promise<Map<string, FabricSample>> {
    if (sampleIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(samples)
      .where(and(inArray(samples.id, sampleIds), eq(samples.tenantId, this.tenantId)));
    return new Map(rows.map((row) => [row.id, mapSample(row)]));
  }

  private async findRow(sampleId: string): Promise<SampleRow> {
    const rows = await this.db
      .select()
      .from(samples)
      .where(and(eq(samples.id, sampleId), eq(samples.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${sampleId}`, {
        resourceType: "sample",
        resourceId: sampleId,
      });
    }
    return row;
  }
}

function clampLimit(raw: number | undefined, fallback: number, max: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.trunc(raw), 1), max);
}

function sampleCodeExists(): KernelError {
  return new KernelError("KERNEL_REJECTED", "该编码已存在", {
    reason: "SAMPLE_CODE_EXISTS",
  });
}

/** 只把「样品编码唯一索引」翻译成 409；其他唯一约束必须原样冒泡。 */
function isSampleCodeConflict(error: unknown): boolean {
  return (uniqueViolationConstraint(error) ?? "").includes("samples_tenant_code_idx");
}

async function resolveUpdateImages(
  images: SampleImageService,
  sampleId: string,
  parsed: { imageKeys?: string[]; imageIds?: string[] },
) {
  if (parsed.imageKeys !== undefined) return images.resolveKeys(parsed.imageKeys);
  if (parsed.imageIds !== undefined) return images.resolveIds(sampleId, parsed.imageIds);
  return null;
}

function auditSnapshot(row: SampleRow): Record<string, string | number | null> {
  return {
    code: row.code,
    name: row.name,
    unit: row.unit,
    category: row.category,
    color: row.color,
    weightGsm: row.weightGsm,
    widthCm: row.widthCm,
    status: row.status,
    costFloorAmount: row.costFloorAmount,
  };
}
