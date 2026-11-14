import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "./env";

/**
 * 对象存储适配层（S3 兼容协议，同一份代码适配腾讯云 COS 与本地 MinIO）。
 *
 * 只暴露业务真正需要的四件事：签上传、签读取、删对象、查元信息。
 * key 由调用方（media 层）生成并保证形如 `tenant/<tenantId>/samples/<sampleId>/<uuid>.<ext>`；
 * 这里不拼路径、不做租户判断，避免两处各写一套规则。
 *
 * `head` 是 `POST /api/media/confirm` 的底座：不 HEAD 一次就无法证明客户端真的传了文件。
 * 对外 HTTP 面仍然只有 presign / confirm，不是第四个接口。
 */
export interface PresignPutInput {
  objectKey: string;
  contentType: string;
  expiresInSeconds: number;
}

export interface ObjectHead {
  contentType: string | null;
  contentLength: number | null;
}

export interface ObjectStorage {
  presignPut(input: PresignPutInput): Promise<string>;
  signGet(objectKey: string, expiresInSeconds?: number): Promise<string>;
  head(objectKey: string): Promise<ObjectHead | null>;
  /**
   * 读对象字节。只给服务端内部用（图像向量索引要把原图交给 embedding 模型），
   * 绝不能把返回的字节直接回给客户端 —— 那会绕过 CDN 与鉴权。
   * 对象不存在返回 null（与 `head` 一致），其余错误冒泡。
   */
  get(objectKey: string): Promise<ObjectBytes | null>;
  delete(objectKey: string): Promise<void>;
}

export interface ObjectBytes {
  contentType: string;
  bytes: Buffer;
}

export interface S3StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      // SDK v3 默认给 PutObject 附 crc32 校验参数，会把预签名 URL 变成
      // 「客户端必须补发 x-amz-checksum-crc32」的形状，移动端直传会 403。
      // 只在协议要求时才计算校验和。
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async presignPut(input: PresignPutInput): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        ContentType: input.contentType,
      }),
      { expiresIn: input.expiresInSeconds },
    );
  }

  async signGet(objectKey: string, expiresInSeconds = 600): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      { expiresIn: expiresInSeconds },
    );
  }

  async head(objectKey: string): Promise<ObjectHead | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      return {
        contentType: result.ContentType ?? null,
        contentLength: result.ContentLength ?? null,
      };
    } catch (error) {
      // 404 / NoSuchKey 都表示「对象不存在」，交给调用方按业务错误处理；
      // 其余错误（网络、鉴权）必须冒泡，不能伪装成「没传」。
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async get(objectKey: string): Promise<ObjectBytes | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      const body = result.Body;
      if (!body) return null;
      const bytes = Buffer.from(await body.transformToByteArray());
      return { contentType: result.ContentType ?? "application/octet-stream", bytes };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(objectKey: string): Promise<void> {
    // TODO(P1, WAN-116): 孤儿对象回收后台任务——先只保证删除样品时 DB 行级联清掉，
    // 桶里的对象暂时保留，等 P1 的回收任务按 object_key 反查后统一删除。
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export function createObjectStorageFromEnv(env: Env): ObjectStorage {
  return new S3ObjectStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}

/** 公开读地址：优先 `MEDIA_BASE_URL`（CDN），未配时回落 `S3_ENDPOINT/<bucket>`。 */
export function mediaBaseUrl(env: Env): string {
  const base = env.MEDIA_BASE_URL ?? `${env.S3_ENDPOINT.replace(/\/+$/, "")}/${env.S3_BUCKET}`;
  return base.replace(/\/+$/, "");
}
