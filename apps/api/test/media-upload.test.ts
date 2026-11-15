import { describe, expect, it } from "vitest";
import { KernelError } from "../src/kernel";
import type { Kernel } from "../src/kernel";
import { MediaService } from "../src/media/media.service";
import { loadEnv } from "../src/platform/env";
import { resolveAllowedHosts } from "../src/platform/media";
import type { ObjectBytes, ObjectHead, ObjectStorage } from "../src/platform/storage";

/**
 * presign / confirm 的安全边界（无数据库、无对象存储）。
 * 覆盖验收 2 / 3：mime 白名单、体积上限、别家样品、别家租户 key、未上传对象。
 */
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const SAMPLE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SAMPLE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

class FakeStorage implements ObjectStorage {
  readonly objects = new Map<string, ObjectHead>();
  readonly presigned: { objectKey: string; contentType: string }[] = [];
  readonly deleted: string[] = [];

  presignPut(input: {
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string> {
    this.presigned.push({ objectKey: input.objectKey, contentType: input.contentType });
    return Promise.resolve(`https://s3.test/weave-media/${input.objectKey}?X-Amz-Signature=fake`);
  }

  signGet(objectKey: string): Promise<string> {
    return Promise.resolve(`https://signed.test/${objectKey}?sig=fake`);
  }

  head(objectKey: string): Promise<ObjectHead | null> {
    return Promise.resolve(this.objects.get(objectKey) ?? null);
  }

  put(objectKey: string, bytes: Buffer): Promise<void> {
    this.objects.set(objectKey, { contentType: "image/webp", contentLength: bytes.length });
    return Promise.resolve();
  }

  get(objectKey: string): Promise<ObjectBytes | null> {
    // 这个文件只测 presign/confirm 的安全边界，不读字节。
    return Promise.resolve(
      this.objects.has(objectKey)
        ? { contentType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8]) }
        : null,
    );
  }

  delete(objectKey: string): Promise<void> {
    this.deleted.push(objectKey);
    return Promise.resolve();
  }
}

function fakeKernel(tenantId: string, ownedSampleIds: string[]): Kernel {
  const attached: Parameters<Kernel["sampleImages"]["attach"]>[0][] = [];
  const rows: {
    id: string;
    tenantId: string;
    sampleId: string;
    objectKey: string;
    variant: string;
    isPrimary: boolean;
    mimeType: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    sortOrder: number;
    indexStatus: string;
    indexError: string | null;
    thumbStatus: string;
    thumbError: string | null;
    thumb320Key: string | null;
    thumb640Key: string | null;
    createdAt: Date;
  }[] = [];
  const kernel = {
    tenantId,
    samples: {
      getById: (id: string) => {
        if (!ownedSampleIds.includes(id)) {
          throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${id}`, {
            resourceType: "sample",
            resourceId: id,
          });
        }
        return Promise.resolve({ id });
      },
    },
    sampleImages: {
      attach: (input: Parameters<Kernel["sampleImages"]["attach"]>[0]) => {
        attached.push(input);
        const row = {
          id: "99999999-9999-4999-8999-999999999999",
          tenantId,
          sampleId: input.sampleId,
          objectKey: input.objectKey,
          variant: input.variant,
          isPrimary: input.isPrimary,
          mimeType: input.mimeType,
          byteSize: input.byteSize,
          width: input.width ?? null,
          height: input.height ?? null,
          sortOrder: input.sortOrder ?? 0,
          indexStatus: "pending",
          indexError: null,
          thumbStatus: "pending",
          thumbError: null,
          thumb320Key: null,
          thumb640Key: null,
          createdAt: new Date(),
        };
        rows.push(row);
        return Promise.resolve(row);
      },
      // confirm 之后会回读一次拿最新索引状态（S4）。
      findById: (imageId: string) => {
        const row = rows.find((entry) => entry.id === imageId);
        return Promise.resolve(row ? { ...row, indexStatus: "ready" } : null);
      },
    },
    // 这个文件不测索引本身：索引失败/成功的行为由 s4-image-search 集成测试覆盖。
    imageIndex: {
      requestIndex: () => Promise.resolve(),
    },
    // confirm 会尝试派生缩略图；这个文件不测派生本身（由 thumbnails 用例覆盖）。
    thumbs: {
      derive: () => Promise.resolve("missing"),
    },
  };
  (kernel as unknown as { attached: typeof attached }).attached = attached;
  return kernel as unknown as Kernel;
}

function service(options: { maxBytes?: number; baseUrl?: string } = {}) {
  const source: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    AUTH_MODE: "dev",
    MEDIA_MAX_BYTES: String(options.maxBytes ?? 10_485_760),
    MEDIA_PRESIGN_TTL_SECONDS: "600",
  };
  delete source.MEDIA_BASE_URL;
  if (options.baseUrl !== undefined) source.MEDIA_BASE_URL = options.baseUrl;
  const env = loadEnv(source);
  const storage = new FakeStorage();
  return { media: new MediaService(storage, env), storage, env };
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KernelError) return error.details.reason ?? "";
    throw error;
  }
  throw new Error("预期抛错但没有");
}

describe("POST /api/media/presign 的入参边界", () => {
  it("只接受 jpeg/png/webp，image/gif 直接拒绝", async () => {
    const { media, storage } = service();
    const kernel = fakeKernel(TENANT_A, [SAMPLE_A]);
    expect(await reasonOf(media.presign(kernel, { mimeType: "image/gif", byteSize: 100 }))).toBe(
      "MEDIA_INPUT_INVALID",
    );
    expect(storage.presigned).toHaveLength(0);
  });

  it("超过 MEDIA_MAX_BYTES 拒绝", async () => {
    const { media } = service({ maxBytes: 1024 });
    const kernel = fakeKernel(TENANT_A, [SAMPLE_A]);
    expect(await reasonOf(media.presign(kernel, { mimeType: "image/jpeg", byteSize: 1025 }))).toBe(
      "MEDIA_TOO_LARGE",
    );
  });

  it("客户端自带 objectKey / key 一律拒绝（防止覆盖他人对象）", async () => {
    const { media } = service();
    const kernel = fakeKernel(TENANT_A, [SAMPLE_A]);
    expect(
      await reasonOf(
        media.presign(kernel, {
          mimeType: "image/jpeg",
          byteSize: 100,
          objectKey: `tenant/${TENANT_B}/samples/${SAMPLE_B}/evil.jpg`,
        }),
      ),
    ).toBe("MEDIA_INPUT_INVALID");
  });

  it("key 由服务端生成，且租户段固定为当前租户", async () => {
    const { media, storage } = service();
    const kernel = fakeKernel(TENANT_A, [SAMPLE_A]);
    const result = await media.presign(kernel, {
      mimeType: "image/webp",
      byteSize: 2048,
      sampleId: SAMPLE_A,
    });
    expect(result.objectKey).toMatch(
      new RegExp(`^tenant/${TENANT_A}/samples/${SAMPLE_A}/[0-9a-f-]{36}\\.webp$`),
    );
    expect(result.method).toBe("PUT");
    expect(result.headers["Content-Type"]).toBe("image/webp");
    expect(storage.presigned[0]?.contentType).toBe("image/webp");
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("purpose=inbound 签出 inbound/ 前缀的 key，且不能与 sampleId 同时使用", async () => {
    const { media, storage } = service();
    const kernel = fakeKernel(TENANT_A, [SAMPLE_A]);
    const result = await media.presign(kernel, {
      mimeType: "image/png",
      byteSize: 4096,
      purpose: "inbound",
    });
    expect(result.objectKey).toMatch(
      new RegExp(`^tenant/${TENANT_A}/inbound/[0-9a-f-]{36}\\.png$`),
    );
    expect(storage.presigned[0]?.objectKey).toBe(result.objectKey);

    await expect(
      media.presign(kernel, {
        mimeType: "image/png",
        byteSize: 4096,
        purpose: "inbound",
        sampleId: SAMPLE_A,
      }),
    ).rejects.toMatchObject({ code: "KERNEL_REJECTED" });
  });

  it("返回上传后可直接 GET 的 publicUrl（移动端找样靠它把图交给 T-001）", async () => {
    const { media } = service();
    const kernel = fakeKernel(TENANT_A, [SAMPLE_A]);
    const result = await media.presign(kernel, {
      mimeType: "image/jpeg",
      byteSize: 2048,
    });
    // 未配 MEDIA_BASE_URL 时是短期签名 URL；客户端只需原样回传，不需要拼地址。
    expect(result.publicUrl).toContain(result.objectKey);
    expect(result.publicUrl).toMatch(/^https?:\/\//);
  });

  it("别的租户的 sampleId 签不出 key（404 语义）", async () => {
    const { media, storage } = service();
    const kernel = fakeKernel(TENANT_A, [SAMPLE_A]);
    await expect(
      media.presign(kernel, { mimeType: "image/png", byteSize: 100, sampleId: SAMPLE_B }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(storage.presigned).toHaveLength(0);
  });
});

describe("POST /api/media/confirm 的校验", () => {
  const keyOf = (tenant: string, sample: string, ext = "jpg") =>
    `tenant/${tenant}/samples/${sample}/33333333-3333-4333-8333-333333333333.${ext}`;

  it("对象不存在时拒绝写入", async () => {
    const { media } = service();
    const kernel = fakeKernel(TENANT_A, [SAMPLE_A]);
    expect(
      await reasonOf(
        media.confirm(
          kernel,
          { actor: { type: "HUMAN", id: "h1" } },
          { objectKey: keyOf(TENANT_A, SAMPLE_A) },
        ),
      ),
    ).toBe("MEDIA_NOT_UPLOADED");
  });

  it("别的租户的 key 无法用来写自己的样品", async () => {
    const { media, storage } = service();
    const kernel = fakeKernel(TENANT_A, [SAMPLE_A]);
    const key = keyOf(TENANT_B, SAMPLE_B);
    storage.objects.set(key, { contentType: "image/jpeg", contentLength: 100 });
    expect(
      await reasonOf(
        media.confirm(kernel, { actor: { type: "HUMAN", id: "h1" } }, { objectKey: key }),
      ),
    ).toBe("MEDIA_KEY_OUTSIDE_TENANT");
    expect((kernel as unknown as { attached: unknown[] }).attached).toHaveLength(0);
  });

  it("content-type 与预签名不一致时拒绝", async () => {
    const { media, storage } = service();
    const kernel = fakeKernel(TENANT_A, [SAMPLE_A]);
    const key = keyOf(TENANT_A, SAMPLE_A);
    storage.objects.set(key, { contentType: "text/html", contentLength: 100 });
    expect(
      await reasonOf(
        media.confirm(kernel, { actor: { type: "HUMAN", id: "h1" } }, { objectKey: key }),
      ),
    ).toBe("MEDIA_CONTENT_TYPE_MISMATCH");
  });

  it("对象体积超限时拒绝", async () => {
    const { media, storage } = service({ maxBytes: 100 });
    const kernel = fakeKernel(TENANT_A, [SAMPLE_A]);
    const key = keyOf(TENANT_A, SAMPLE_A);
    storage.objects.set(key, { contentType: "image/jpeg", contentLength: 101 });
    expect(
      await reasonOf(
        media.confirm(kernel, { actor: { type: "HUMAN", id: "h1" } }, { objectKey: key }),
      ),
    ).toBe("MEDIA_TOO_LARGE");
  });

  it("校验通过后写入样品图片，并返回读模型 URL", async () => {
    const { media, storage } = service({ baseUrl: "https://cdn.weaveorder.cn" });
    const kernel = fakeKernel(TENANT_A, [SAMPLE_A]);
    const key = keyOf(TENANT_A, SAMPLE_A);
    storage.objects.set(key, { contentType: "image/jpeg; charset=binary", contentLength: 4096 });
    const result = await media.confirm(
      kernel,
      { actor: { type: "HUMAN", id: "h1" } },
      { objectKey: key, isPrimary: true, width: 800, height: 600 },
    );
    expect(result.image.url).toBe(`https://cdn.weaveorder.cn/${key}`);
    expect(result.image).toMatchObject({ isPrimary: true, width: 800, height: 600 });
    const attached = (kernel as unknown as { attached: unknown[] }).attached;
    expect(attached).toHaveLength(1);
  });

  it("未配 MEDIA_BASE_URL 时退回签名 URL（桶不公开）", async () => {
    const { media, storage } = service();
    const kernel = fakeKernel(TENANT_A, [SAMPLE_A]);
    const key = keyOf(TENANT_A, SAMPLE_A, "png");
    storage.objects.set(key, { contentType: "image/png", contentLength: 10 });
    const result = await media.confirm(
      kernel,
      { actor: { type: "HUMAN", id: "h1" } },
      { objectKey: key },
    );
    expect(result.image.url).toContain("https://signed.test/");
  });
});

describe("取图白名单包含 MEDIA_BASE_URL", () => {
  it("自动并入 CDN 主机，无需重复配置 MEDIA_ALLOWED_HOSTS", () => {
    const hosts = resolveAllowedHosts({
      MEDIA_ALLOWED_HOSTS: "legacy.example.com",
      MEDIA_BASE_URL: "https://cdn.weaveorder.cn/media",
    });
    expect(hosts).toEqual(["legacy.example.com", "cdn.weaveorder.cn"]);
  });
});
