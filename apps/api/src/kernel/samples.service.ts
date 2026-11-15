import { samples } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import { CreateSampleInput, UpdateSampleInput } from "@weave-order/schema";
import type { FabricSample, MemberRole, SampleStatus } from "@weave-order/schema";
import { and, asc, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
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

type SampleRow = typeof samples.$inferSelect;

/** 样品写权限：sales / viewer / 财务 / 跟单只读。 */
const SAMPLE_WRITE_ROLES: ReadonlySet<MemberRole> = new Set(["OWNER", "MANAGER", "SAMPLE_ADMIN"]);

/** 无角色（系统任务 / 智能体内核路径）视为可写；角色裁剪只发生在人类请求上。 */
export function mayWriteSamples(role?: MemberRole): boolean {
  if (!role) return true;
  return SAMPLE_WRITE_ROLES.has(role);
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
    weight: row.weight,
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

export interface SampleListFilters {
  query?: string | null;
  category?: string | null;
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
            weight: parsed.weight ?? null,
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
        weight: parsed.weight ?? null,
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
    if (parsed.weight !== undefined) values.weight = parsed.weight;
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
      (parsed.weight !== undefined && parsed.weight !== before.weight);
    const preparedVector = textChanged
      ? await this.index.prepare({
          code: parsed.code ?? before.code,
          name: parsed.name ?? before.name,
          composition: parsed.composition ?? before.composition,
          category: parsed.category ?? before.category,
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
  async listPage(filters: SampleListFilters = {}, ctx?: KernelContext): Promise<SamplePage> {
    const limit = clampLimit(filters.limit, 24, 100);
    const conditions = [eq(samples.tenantId, this.tenantId)];
    const status = filters.status ?? "ACTIVE";
    if (status !== "ALL") conditions.push(eq(samples.status, status));
    if (filters.category) conditions.push(eq(samples.category, filters.category));
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
    if (status !== "ALL") categoryConditions.push(eq(samples.status, status));
    const categoryRows = await this.db
      .selectDistinct({ category: samples.category })
      .from(samples)
      .where(and(...categoryConditions, sql`${samples.category} IS NOT NULL`))
      .orderBy(asc(samples.category));
    const categories = categoryRows
      .map((entry) => entry.category)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    return {
      samples: pageRows.map((row) => presentSample(row, ctx?.actor.role)),
      nextCursor,
      hasMore,
      total,
      remaining,
      categories,
    };
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
    status: row.status,
    costFloorAmount: row.costFloorAmount,
  };
}
