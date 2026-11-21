import { fieldOptions, samples } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import {
  CreateSampleInput,
  CreateSampleDraftInput,
  SAMPLE_FILTER_TIER_LIMIT,
  SampleDraftResponse,
  UpdateSampleInput,
  hasCapability,
  isSampleStatusAvailable,
  normalizeFieldValue,
  parseWeightGsm,
} from "@weave-order/schema";
import type { DraftFieldInput, FabricSample, MemberRole, SampleStatus } from "@weave-order/schema";
import { and, asc, count, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
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

export function mapSample(row: SampleRow): FabricSample {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    composition: row.composition,
    category: row.category,
    color: row.color,
    weight: row.weight,
    weightGsm: row.weightGsm,
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
  /** 克重档位原文，精确匹配 `samples.weight`。 */
  weights?: string[] | null;
  /** 颜色原文，精确匹配 `samples.color`。 */
  colors?: string[] | null;
  /** 克重区间（g/m²，闭区间），只命中解析出 `weight_gsm` 的样品。 */
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
  ) {}

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
    const preparedVector = await this.index.prepare({
      code: parsed.code,
      name: parsed.name,
      composition: parsed.composition ?? null,
      category: parsed.category ?? null,
      color: parsed.color ?? null,
      weight: parsed.weight ?? null,
    });
    try {
      const row = await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(samples)
          .values({
            tenantId: this.tenantId,
            code: parsed.code,
            name: parsed.name,
            composition: parsed.composition ?? null,
            category: parsed.category ?? null,
            color: parsed.color ?? null,
            weight: parsed.weight ?? null,
            weightGsm: parseWeightGsm(parsed.weight),
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
    const rows = await tx
      .insert(samples)
      .values({
        tenantId: this.tenantId,
        code: parsed.code,
        name: parsed.name,
        composition: parsed.composition ?? null,
        category: parsed.category ?? null,
        color: parsed.color ?? null,
        weight: parsed.weight ?? null,
        weightGsm: parseWeightGsm(parsed.weight),
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

    const prefix = sampleCodePrefix();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = `${prefix}${String(await this.nextSampleSequence(prefix)).padStart(4, "0")}`;
      try {
        const row = await this.db.transaction(async (tx) => {
          const rows = await tx
            .insert(samples)
            .values({
              tenantId: this.tenantId,
              code,
              name: parsed.name ?? "待确认样品",
              composition: parsed.composition ?? null,
              category: parsed.category ?? null,
              color: parsed.color ?? null,
              weight: parsed.weight ?? null,
              weightGsm: parseWeightGsm(parsed.weight),
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
          const fields = this.draftFieldInputs(parsed);
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
        });
        return this.draftResponse(row, true);
      } catch (error) {
        const duplicate = await this.findByDraftSource(parsed.sourceId);
        if (duplicate) return this.draftResponse(duplicate, false);
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new KernelError("KERNEL_REJECTED", "样品编号连续冲突，请稍后重试", {
      reason: "SAMPLE_CODE_EXISTS",
    });
  }

  private draftFieldInputs(
    parsed: ReturnType<typeof CreateSampleDraftInput.parse>,
  ): DraftFieldInput[] {
    const fields: DraftFieldInput[] = [];
    const topLevel: Array<[string, string | null | undefined]> = [
      ["name", parsed.name],
      ["composition", parsed.composition],
      ["category", parsed.category],
      ["color", parsed.color],
      ["weight", parsed.weight],
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
    if (parsed.composition !== undefined) values.composition = parsed.composition;
    if (parsed.category !== undefined) values.category = parsed.category;
    if (parsed.color !== undefined) values.color = parsed.color;
    if (parsed.weight !== undefined) {
      values.weight = parsed.weight;
      // 克重只从原文派生；客户端不能直接写 `weightGsm`，避免两套口径打架。
      values.weightGsm = parseWeightGsm(parsed.weight);
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
      (parsed.composition !== undefined && (parsed.composition ?? null) !== before.composition) ||
      (parsed.category !== undefined && (parsed.category ?? null) !== before.category) ||
      (parsed.color !== undefined && (parsed.color ?? null) !== before.color) ||
      (parsed.weight !== undefined && parsed.weight !== before.weight);
    const preparedVector = textChanged
      ? await this.index.prepare({
          code: parsed.code ?? before.code,
          name: parsed.name ?? before.name,
          composition: parsed.composition ?? before.composition,
          category: parsed.category ?? before.category,
          color: parsed.color ?? before.color,
          weight: parsed.weight ?? before.weight,
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

  private async nextSampleSequence(prefix: string): Promise<number> {
    const start = prefix.length + 1;
    const result = await this.db.execute<{ max_seq: number | string | null }>(sql`
      SELECT MAX(substring(code from (${start})::int)::int) AS max_seq
      FROM samples
      WHERE tenant_id = ${this.tenantId}
        AND code LIKE ${`${prefix}%`}
        AND substring(code from (${start})::int) ~ '^[0-9]+$'
    `);
    const max = result.rows[0]?.max_seq;
    return (max === null || max === undefined ? 0 : Number(max)) + 1;
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
      conditions.push(inArray(samples.weight, filters.weights));
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
      this.listTierOptions(samples.weight, status),
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
    column: typeof samples.composition | typeof samples.weight,
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
    status: row.status,
    costFloorAmount: row.costFloorAmount,
  };
}
