import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  SAMPLE_FILTER_MAX_COMPOSITION_LENGTH,
  SAMPLE_FILTER_MAX_TIER_LENGTH,
  SAMPLE_FILTER_MAX_WEIGHT_TIERS,
} from "@weave-order/schema";
import type { FabricSample } from "@weave-order/schema";
import type { Kernel } from "../kernel";
import type { MediaService } from "../media/media.service";
import type { SampleImageRow } from "../kernel/sample-images.service";
import { rethrowHttp } from "./controllers";
import type { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL, MEDIA_SERVICE } from "./tokens";

const SAMPLE_STATUS_FILTERS = ["ACTIVE", "ARCHIVED", "ALL"] as const;
type SampleStatusFilter = (typeof SAMPLE_STATUS_FILTERS)[number];

function parseStatus(raw: string | undefined): SampleStatusFilter {
  if (raw === undefined || raw === "") return "ACTIVE";
  if ((SAMPLE_STATUS_FILTERS as readonly string[]).includes(raw)) return raw as SampleStatusFilter;
  throw new BadRequestException("status 只接受 ACTIVE / ARCHIVED / ALL");
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new BadRequestException("limit 必须是数字");
  return parsed;
}

/** 空串等同于不传；超长一律 400，不做静默截断（否则筛选结果看起来像 bug）。 */
function parseComposition(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (Array.isArray(raw)) throw new BadRequestException("成分筛选参数只能出现一次");
  const value = raw.trim();
  if (value === "") return null;
  if (value.length > SAMPLE_FILTER_MAX_COMPOSITION_LENGTH) {
    throw new BadRequestException(
      `成分筛选最多 ${SAMPLE_FILTER_MAX_COMPOSITION_LENGTH} 个字符`,
    );
  }
  return value;
}

/**
 * `weights` 是逗号分隔的档位原文：每项 trim 后精确匹配 `samples.weight`。
 * 选项来自真实数据，所以这里不做任何模糊化（不改大小写、不抽数字）。
 */
function parseWeights(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  if (Array.isArray(raw)) throw new BadRequestException("克重档位参数只能出现一次");
  if (raw.trim() === "") return null;
  const items = raw.split(",").map((item) => item.trim());
  if (items.some((item) => item === "")) {
    throw new BadRequestException("克重档位不能为空");
  }
  if (items.length > SAMPLE_FILTER_MAX_WEIGHT_TIERS) {
    throw new BadRequestException(`克重档位最多选 ${SAMPLE_FILTER_MAX_WEIGHT_TIERS} 个`);
  }
  if (items.some((item) => item.length > SAMPLE_FILTER_MAX_TIER_LENGTH)) {
    throw new BadRequestException(
      `单个克重档位最多 ${SAMPLE_FILTER_MAX_TIER_LENGTH} 个字符`,
    );
  }
  return [...new Set(items)];
}

/**
 * 样品 HTTP 面：图墙列表（游标分页）+ 详情 + 新建 / 编辑 / 归档。
 *
 * 图片 URL 一律由服务端按 object_key 生成，响应里不出现 object_key；
 * 成本底线在 `presentSample` 已按角色裁剪，控制器不重复判断权限。
 */
@Controller("api")
export class SampleController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
    @Inject(MEDIA_SERVICE) private readonly media: MediaService,
  ) {}

  @Get("samples")
  async list(
    @Query("query") query?: string,
    @Query("category") category?: string,
    @Query("composition") composition?: string,
    @Query("weights") weights?: string,
    @Query("status") status?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => {
          const page = await kernel.samples.listPage(
            {
              query: query?.trim() || null,
              category: category?.trim() || null,
              composition: parseComposition(composition),
              weights: parseWeights(weights),
              status: parseStatus(status),
              cursor: cursor ?? null,
              limit: parseLimit(limit),
            },
            ctx,
          );
          const images = await kernel.sampleImages.listForSampleIds(
            page.samples.map((sample) => sample.id),
          );
          return {
            ...page,
            samples: await Promise.all(
              page.samples.map((sample) => this.withImages(sample, images.get(sample.id) ?? [])),
            ),
          };
        },
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Get("samples/:id")
  async detail(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => {
          const sample = await kernel.samples.getById(id, ctx.actor.role);
          const rows = await kernel.sampleImages.listForSample(sample.id);
          return { sample: await this.withImages(sample, rows) };
        },
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("samples")
  async create(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => {
          const sample = await kernel.samples.create(body, ctx);
          const rows = await kernel.sampleImages.listForSample(sample.id);
          return { sample: await this.withImages(sample, rows) };
        },
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Patch("samples/:id")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => {
          const sample = await kernel.samples.update(id, body, ctx);
          const rows = await kernel.sampleImages.listForSample(sample.id);
          return { sample: await this.withImages(sample, rows) };
        },
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  /**
   * 单张图重试（缩略图派生 / 图像向量索引）。
   *
   * 返回整份样品读模型：客户端点一次「重试」就拿到最新状态徽标，
   * 不需要再猜是「重试成功但界面没刷新」还是「还在跑」。
   */
  @Post("samples/:id/images/:imageId/retry")
  @HttpCode(200)
  async retryImage(
    @Param("id") id: string,
    @Param("imageId") imageId: string,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => {
          await kernel.samples.retryImage(id, imageId, ctx);
          const sample = await kernel.samples.getById(id, ctx.actor.role);
          const rows = await kernel.sampleImages.listForSample(sample.id);
          return { sample: await this.withImages(sample, rows) };
        },
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  /** 归档是软删：`status=ARCHIVED`，图片行与审计都保留。 */
  @Post("samples/:id/archive")
  @HttpCode(200)
  async archive(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => {
          const sample = await kernel.samples.archive(id, ctx);
          const rows = await kernel.sampleImages.listForSample(sample.id);
          return { sample: await this.withImages(sample, rows) };
        },
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  private async withImages(sample: FabricSample, rows: SampleImageRow[]): Promise<FabricSample> {
    const images = await this.media.presentAll(rows);
    const primary = images.find((image) => image.isPrimary) ?? images[0] ?? null;
    return { ...sample, images, primaryImageUrl: primary?.url ?? null };
  }
}
