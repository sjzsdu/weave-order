import { randomUUID } from "node:crypto";
import type { SampleImage } from "@weave-order/schema";
import { SampleImageVariant as SampleImageVariantSchema } from "@weave-order/schema";
import { z } from "zod";
import type { Kernel, KernelContext } from "../kernel";
import { KernelError } from "../kernel";
import { mayWriteSamples } from "../kernel/samples.service";
import type { SampleImageRow } from "../kernel/sample-images.service";
import type { Env } from "../platform/env";
import { loadEnv } from "../platform/env";
import type { ObjectStorage } from "../platform/storage";
import { objectUrl } from "../platform/thumbnail";

/**
 * 图片上传编排层：把「客户端要传图」拆成三次可信交互。
 *
 *   1. `presign`：服务端生成 object_key 并签一个 PUT，客户端拿不到桶和写权限；
 *   2. 客户端直传对象存储（流量不过 API）；
 *   3. `confirm`：服务端 HEAD 一次对象，元信息对得上才写 `sample_images`。
 *
 * 安全边界：
 * - 只接受三种图片 mime 且体积不超过 `MEDIA_MAX_BYTES`；
 * - key 一律服务端生成，客户端传 key 会被 schema 拒绝（strict），从根上杜绝覆盖他人对象；
 * - confirm 只接受 `tenant/<本租户>/samples/<uuid>/<uuid>.<ext>` 形状的 key，别的租户的 key 直接 400。
 */

export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

const EXTENSION_BY_MIME: Record<AllowedImageMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const PresignInputSchema = z
  .object({
    /** 客户端声明的 mime；只接受白名单三种。 */
    mimeType: z.enum(ALLOWED_IMAGE_MIME_TYPES),
    byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sampleId: z.string().uuid().optional(),
    /** 回款凭证：为某笔应收签一个只读用途的上传地址。 */
    receivableId: z.string().uuid().optional(),
    /**
     * 契约兼容字段：真正落库的 variant 由 confirm 决定（presign 是无状态的）。
     * 不带 sampleId 的 key 落在 `uploads/` 下，confirm 会拒绝挂载——预留非样品图片用途。
     */
    variant: SampleImageVariantSchema.default("primary"),
  })
  // 客户端传 objectKey / key / url 一律拒绝：key 只能由服务端生成。
  .strict();

const ConfirmInputSchema = z
  .object({
    objectKey: z.string().min(1).max(512),
    variant: SampleImageVariantSchema.optional(),
    isPrimary: z.boolean().optional(),
    width: z.number().int().positive().max(100_000).optional(),
    height: z.number().int().positive().max(100_000).optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export interface PresignResult {
  uploadUrl: string;
  /**
   * 上传完成后可直接 GET 的读地址（CDN 直链；未配 CDN 时为短期签名 URL）。
   *
   * 为什么随 presign 一起返回：移动端「拍照找样」先把查询图直传对象存储，
   * 再把 URL 交给 T-001 的 `imageUrl` 变体。客户端只有 objectKey 是拼不出
   * 「当前环境可读」的地址的（本地 MinIO 是签名 URL、生产是 CDN），
   * 让客户端猜会让真实后端链路必然失败。
   */
  publicUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  objectKey: string;
  expiresAt: string;
}

export interface ConfirmResult {
  image: SampleImage;
}

export class MediaService {
  private readonly env: Env;

  constructor(
    private readonly storage: ObjectStorage,
    env: Env = loadEnv(),
  ) {
    this.env = env;
  }

  /** 生成上传预签名。key 由服务端按租户与样品拼出，客户端无权指定。 */
  async presign(kernel: Kernel, input: unknown, ctx?: KernelContext): Promise<PresignResult> {
    const parsed = PresignInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new KernelError("KERNEL_REJECTED", "上传参数不合法：仅支持 jpeg/png/webp 图片", {
        reason: "MEDIA_INPUT_INVALID",
      });
    }
    const { mimeType, byteSize, sampleId, receivableId } = parsed.data;
    if (sampleId && receivableId) {
      throw new KernelError("KERNEL_REJECTED", "上传地址只能有一个用途", {
        reason: "MEDIA_INPUT_INVALID",
      });
    }
    // 样品图是样品的子资源：没有样品写权限的角色（sales / viewer）不能签上传。
    // 回款凭证不适用这条：财务只见应收、不写样品，但必须能给回款传凭证；
    // 凭证的归属由后面 receivables.getById(id, ctx) 的可见性校验保证。
    if (sampleId && ctx && !mayWriteSamples(ctx.actor.role)) {
      throw new KernelError("PERMISSION_DENIED", "当前角色没有样品写权限，不能上传样品图");
    }
    if (byteSize > this.env.MEDIA_MAX_BYTES) {
      throw new KernelError(
        "KERNEL_REJECTED",
        `图片超过体积上限（${this.env.MEDIA_MAX_BYTES} 字节）`,
        { reason: "MEDIA_TOO_LARGE" },
      );
    }
    if (sampleId) {
      // 不属于当前租户的样品会在这里得到 RESOURCE_NOT_FOUND（404），不会签出 key。
      await kernel.samples.getById(sampleId);
    }
    if (receivableId) {
      // 看不见这笔应收的人不配给它传凭证；越权同样按不存在返回。
      await kernel.receivables.getById(receivableId, ctx);
    }
    const objectKey = receivableId
      ? `tenant/${kernel.tenantId}/receipts/${receivableId}/${randomUUID()}.${EXTENSION_BY_MIME[mimeType]}`
      : this.buildObjectKey(kernel.tenantId, sampleId, mimeType);
    const expiresInSeconds = this.env.MEDIA_PRESIGN_TTL_SECONDS;
    const uploadUrl = await this.storage.presignPut({
      objectKey,
      contentType: mimeType,
      expiresInSeconds,
    });
    return {
      uploadUrl,
      publicUrl: await this.imageUrl(objectKey),
      method: "PUT",
      headers: { "Content-Type": mimeType },
      objectKey,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
  }

  /**
   * 校验对象确实已上传且元信息匹配后，写入 `sample_images`。
   * `sampleId` 从 key 中解析并再次做租户归属校验——客户端无法用一个合法 key 挂到别家样品。
   */
  async confirm(kernel: Kernel, ctx: KernelContext, input: unknown): Promise<ConfirmResult> {
    if (!mayWriteSamples(ctx.actor.role)) {
      throw new KernelError("PERMISSION_DENIED", "当前角色没有样品写权限，不能挂载样品图");
    }
    const parsed = ConfirmInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new KernelError("KERNEL_REJECTED", "确认参数不合法", {
        reason: "MEDIA_INPUT_INVALID",
      });
    }
    const located = this.parseObjectKey(kernel.tenantId, parsed.data.objectKey);
    const head = await this.storage.head(parsed.data.objectKey);
    if (!head) {
      throw new KernelError("KERNEL_REJECTED", "对象不存在：客户端还没有完成上传", {
        reason: "MEDIA_NOT_UPLOADED",
      });
    }
    const contentType = normalizeMime(head.contentType);
    if (contentType !== located.mimeType) {
      throw new KernelError("KERNEL_REJECTED", "对象类型与预签名时不一致", {
        reason: "MEDIA_CONTENT_TYPE_MISMATCH",
      });
    }
    const byteSize = head.contentLength;
    if (byteSize === null || byteSize <= 0) {
      throw new KernelError("KERNEL_REJECTED", "对象体积不可信，拒绝写入", {
        reason: "MEDIA_SIZE_UNKNOWN",
      });
    }
    if (byteSize > this.env.MEDIA_MAX_BYTES) {
      throw new KernelError(
        "KERNEL_REJECTED",
        `图片超过体积上限（${this.env.MEDIA_MAX_BYTES} 字节）`,
        { reason: "MEDIA_TOO_LARGE" },
      );
    }

    const row = await kernel.sampleImages.attach(
      {
        sampleId: located.sampleId,
        objectKey: parsed.data.objectKey,
        variant: parsed.data.variant ?? "primary",
        isPrimary: parsed.data.isPrimary ?? false,
        mimeType: contentType,
        byteSize,
        width: parsed.data.width ?? null,
        height: parsed.data.height ?? null,
        sortOrder: parsed.data.sortOrder ?? 0,
      },
      ctx,
    );
    // 挂图即入队：算图向量走后台（HTTP 路径有 worker），confirm 立即返回 `pending`。
    // 失败不阻塞上传，但会把 `sample_images.index_status` 标成 failed，
    // 图墙据此显示「索引失败」，不会假装「搜不到」。
    await kernel.imageIndex.requestIndex(row.id);
    // 缩略图是持久化展示资源，和向量索引不同：它是图墙可用的前提，
    // 所以在 confirm 里同步派生（sharp 本地 CPU，约 100~300ms），返回即可看图。
    // 失败不阻塞上传：状态落 `thumbStatus=failed`，读模型会回退原图并标注原因。
    await kernel.thumbs.derive(row.id).catch(() => undefined);
    // 回读一次：状态可能是 pending（后台还没算完），前端据此显示「检索中」。
    const fresh = (await kernel.sampleImages.findById(row.id)) ?? row;
    return { image: await this.present(fresh) };
  }

  /** 把 DB 行转成读模型；桶非公开时退回签名 URL。 */
  async present(row: SampleImageRow): Promise<SampleImage> {
    const url = await this.imageUrl(row.objectKey);
    const thumbsReady =
      row.thumbStatus === "ready" && row.thumb320Key !== null && row.thumb320Key !== undefined;
    // 未就绪时回退原图：图墙不会 404，但客户端必须看 `thumbStatus` 标注，
    // 不允许把「原图冒充缩略图」当成正常状态。
    const thumbUrl = thumbsReady
      ? ((await objectUrl(this.env, this.storage, row.thumb320Key!)) ?? url)
      : url;
    const detailUrl =
      row.thumbStatus === "ready" && row.thumb640Key
        ? await objectUrl(this.env, this.storage, row.thumb640Key)
        : null;
    return {
      id: row.id,
      url,
      thumbUrl,
      detailUrl,
      thumbStatus: (row.thumbStatus as SampleImage["thumbStatus"]) ?? "pending",
      thumbError: row.thumbError ?? null,
      variant: row.variant,
      isPrimary: row.isPrimary,
      width: row.width,
      height: row.height,
      indexStatus: (row.indexStatus as SampleImage["indexStatus"]) ?? "pending",
      indexError: row.indexError ?? null,
    };
  }

  async presentAll(rows: SampleImageRow[]): Promise<SampleImage[]> {
    return Promise.all(rows.map((row) => this.present(row)));
  }

  async imageUrl(objectKey: string): Promise<string> {
    // 未配公开读域名 => 桶不公开，发一串短期签名 URL。
    const url = await objectUrl(this.env, this.storage, objectKey);
    if (!url) {
      throw new KernelError("KERNEL_REJECTED", "对象存储未配置，无法生成图片地址", {
        reason: "MEDIA_STORAGE_UNAVAILABLE",
      });
    }
    return url;
  }

  buildObjectKey(
    tenantId: string,
    sampleId: string | undefined,
    mimeType: AllowedImageMime,
  ): string {
    const extension = EXTENSION_BY_MIME[mimeType];
    const scope = sampleId ? `samples/${sampleId}` : "uploads";
    return `tenant/${tenantId}/${scope}/${randomUUID()}.${extension}`;
  }

  parseObjectKey(
    tenantId: string,
    objectKey: string,
  ): { sampleId: string; mimeType: AllowedImageMime } {
    const match =
      /^tenant\/([0-9a-fA-F-]{36})\/samples\/([0-9a-fA-F-]{36})\/[0-9a-fA-F-]{36}\.(jpg|png|webp)$/.exec(
        objectKey,
      );
    if (!match) {
      throw new KernelError("KERNEL_REJECTED", "objectKey 不是本接口签发的图片路径", {
        reason: "MEDIA_KEY_INVALID",
      });
    }
    if (match[1] !== tenantId) {
      // 不把 key 回显到错误里：key 含租户 id，错误体会进日志 / 监控。
      throw new KernelError("KERNEL_REJECTED", "objectKey 不属于当前租户", {
        reason: "MEDIA_KEY_OUTSIDE_TENANT",
      });
    }
    const extension = match[3] as "jpg" | "png" | "webp";
    const mimeType = (Object.keys(EXTENSION_BY_MIME) as AllowedImageMime[]).find(
      (mime) => EXTENSION_BY_MIME[mime] === extension,
    ) as AllowedImageMime;
    return {
      sampleId: match[2] as string,
      mimeType,
    };
  }
}

function normalizeMime(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  if (value === "image/jpg") return "image/jpeg";
  return value;
}
