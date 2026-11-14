import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
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

/** 桶里已有对象（孤儿回收用；只列举不读内容）。 */
export interface StorageObject {
  key: string;
  size: number;
  lastModified: Date | null;
}

export interface ObjectStorage {
  presignPut(input: PresignPutInput): Promise<string>;
  signGet(objectKey: string, expiresInSeconds?: number): Promise<string>;
  head(objectKey: string): Promise<ObjectHead | null>;
  /**
   * 服务端写对象（派生的缩略图 / 重编码后的原图）。
   * 只给服务端内部用：key 仍由服务端按租户规则生成，客户端没有写权限。
   */
  put(objectKey: string, bytes: Buffer, contentType: string): Promise<void>;
  /**
   * 读对象字节。只给服务端内部用（图像向量索引要把原图交给 embedding 模型），
   * 绝不能把返回的字节直接回给客户端 —— 那会绕过 CDN 与鉴权。
   * 对象不存在返回 null（与 `head` 一致），其余错误冒泡。
   */
  get(objectKey: string): Promise<ObjectBytes | null>;
  delete(objectKey: string): Promise<void>;
  /**
   * 按前缀列举对象（孤儿回收）。可选：测试用的内存实现可以不实现，
   * 调用方必须显式处理「存储不支持列举」，不能静默当桶是空的。
   */
  list?(prefix: string): Promise<StorageObject[]>;
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

  async put(objectKey: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: bytes,
        ContentType: contentType,
      }),
    );
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
    // 删样品只级联清 DB 行；桶里的对象由 `maintain:media` 的孤儿回收按引用反查后删除
    // （保护期内不删，避免误删「刚 PUT、还没 confirm」的对象）。
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }

  async list(prefix: string): Promise<StorageObject[]> {
    const objects: StorageObject[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const entry of page.Contents ?? []) {
        if (!entry.Key) continue;
        objects.push({
          key: entry.Key,
          size: entry.Size ?? 0,
          lastModified: entry.LastModified ?? null,
        });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
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
