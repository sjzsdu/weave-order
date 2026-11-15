import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "@weave-order/db";
import {
  DEFAULT_QUERY_UPLOAD_RETENTION_HOURS,
  MediaMaintenanceService,
} from "../src/kernel/media-maintenance.service";
import type { SampleThumbService } from "../src/kernel/sample-thumbs.service";
import type {
  ObjectBytes,
  ObjectHead,
  ObjectStorage,
  PresignPutInput,
  StorageObject,
} from "../src/platform/storage";

/**
 * 查询图（`tenant/<tid>/uploads/`）与孤儿对象回收的破坏性边界（WAN-130）。
 *
 * 不需要真实数据库：引用集合与租户上下文用最小 fake 表达，覆盖三件事：
 * 1. 只删超过保留期、且**未被 `sample_images` 引用**的 `uploads/` 对象
 *    （`POST /api/samples` 的 `imageKeys` 接受 `uploads/` key，先直传再入库是合法契约）；
 * 2. 受 RLS 约束的角色没有设置 `app.tenant_id` 时拒绝清理（否则引用集合为空 = 删光原图）；
 * 3. 干跑、保留期、幂等、前缀隔离。
 */
const TENANT_ID = "33333333-3333-4333-8333-333333333333";
const DAY_MS = 24 * 3600_000;

class MemoryStorage implements ObjectStorage {
  private readonly objects = new Map<
    string,
    { contentType: string; bytes: Buffer; lastModified: Date | null }
  >();

  seed(objectKey: string, size: number, lastModified: Date | null): void {
    this.objects.set(objectKey, {
      contentType: "image/jpeg",
      bytes: Buffer.alloc(size, 1),
      lastModified,
    });
  }

  has(objectKey: string): boolean {
    return this.objects.has(objectKey);
  }

  presignPut(_input: PresignPutInput): Promise<string> {
    return Promise.resolve("http://storage.test/presigned");
  }

  signGet(objectKey: string): Promise<string> {
    return Promise.resolve(`http://storage.test/${objectKey}`);
  }

  head(_objectKey: string): Promise<ObjectHead | null> {
    return Promise.resolve(null);
  }

  put(objectKey: string, bytes: Buffer, contentType: string): Promise<void> {
    this.objects.set(objectKey, { contentType, bytes, lastModified: new Date() });
    return Promise.resolve();
  }

  get(_objectKey: string): Promise<ObjectBytes | null> {
    return Promise.resolve(null);
  }

  delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
    return Promise.resolve();
  }

  list(prefix: string): Promise<StorageObject[]> {
    return Promise.resolve(
      [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({
          key,
          size: value.bytes.length,
          lastModified: value.lastModified,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    );
  }
}

interface ReferenceRow {
  objectKey: string;
  thumb320Key: string | null;
  thumb640Key: string | null;
}

interface FakeDbOptions {
  /** `current_setting('app.tenant_id')` 的返回值；undefined 表示本租户会话。 */
  tenantSetting?: string | null;
  /** 角色是否 SUPERUSER / BYPASSRLS（高权限运维连接）。 */
  bypassesRls?: boolean;
  /** 本租户 `sample_images` 的引用行。 */
  referenced?: ReferenceRow[];
}

/** 只实现清理路径真正用到的两件事：租户上下文查询、引用行查询。 */
function fakeDb(options: FakeDbOptions = {}): Db {
  const tenantSetting = options.tenantSetting === undefined ? TENANT_ID : options.tenantSetting;
  return {
    execute: () =>
      Promise.resolve({
        rows: [{ tenant_id: tenantSetting, bypasses_rls: options.bypassesRls ?? false }],
      }),
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(options.referenced ?? []),
      }),
    }),
  } as unknown as Db;
}

function service(storage: ObjectStorage, db: Db = fakeDb()): MediaMaintenanceService {
  // 缩略图服务不参与清理；显式传 null 而不是造假对象，避免以后误用。
  return new MediaMaintenanceService(db, TENANT_ID, storage, null as unknown as SampleThumbService);
}

function uploadKey(): string {
  return `tenant/${TENANT_ID}/uploads/${randomUUID()}.jpg`;
}

function sampleKey(): string {
  return `tenant/${TENANT_ID}/samples/${randomUUID()}/${randomUUID()}.jpg`;
}

function referenced(key: string): ReferenceRow {
  return { objectKey: key, thumb320Key: null, thumb640Key: null };
}

describe("查询图（uploads/）回收", () => {
  it("默认保留期是 7 天", () => {
    expect(DEFAULT_QUERY_UPLOAD_RETENTION_HOURS).toBe(7 * 24);
  });

  it("干跑只统计条数与字节，不删对象", async () => {
    const storage = new MemoryStorage();
    const old = uploadKey();
    const fresh = uploadKey();
    storage.seed(old, 1000, new Date(Date.now() - 10 * DAY_MS));
    storage.seed(fresh, 500, new Date());

    const report = await service(storage).cleanupQueryUploads({ dryRun: true });

    expect(report.listed).toBe(2);
    expect(report.listedBytes).toBe(1500);
    expect(report.candidates).toBe(1);
    expect(report.candidateBytes).toBe(1000);
    expect(report.deleted).toBe(0);
    expect(storage.has(old)).toBe(true);
    expect(storage.has(fresh)).toBe(true);
  });

  it("只删超过保留期的对象，保留期内的查询图不动", async () => {
    const storage = new MemoryStorage();
    const old = uploadKey();
    const recent = uploadKey();
    storage.seed(old, 2000, new Date(Date.now() - 8 * DAY_MS));
    storage.seed(recent, 800, new Date(Date.now() - 6 * DAY_MS));

    const report = await service(storage).cleanupQueryUploads();

    expect(report.deleted).toBe(1);
    expect(report.deletedBytes).toBe(2000);
    expect(report.skippedWithinRetention).toBe(1);
    expect(report.failures).toEqual([]);
    expect(storage.has(old)).toBe(false);
    expect(storage.has(recent)).toBe(true);
  });

  it("被 sample_images 引用的 uploads/ 对象即使超期也保留（B1）", async () => {
    const storage = new MemoryStorage();
    const stillUsed = uploadKey();
    const orphan = uploadKey();
    storage.seed(stillUsed, 4000, new Date(Date.now() - 30 * DAY_MS));
    storage.seed(orphan, 1200, new Date(Date.now() - 30 * DAY_MS));

    const report = await service(
      storage,
      fakeDb({ referenced: [referenced(stillUsed)] }),
    ).cleanupQueryUploads();

    expect(report.skippedReferenced).toBe(1);
    expect(report.skippedReferencedBytes).toBe(4000);
    expect(report.deleted).toBe(1);
    expect(report.deletedBytes).toBe(1200);
    expect(storage.has(stillUsed)).toBe(true);
    expect(storage.has(orphan)).toBe(false);
  });

  it("缩略图 key 也计入引用白名单", async () => {
    const storage = new MemoryStorage();
    const thumbKey = `tenant/${TENANT_ID}/uploads/${randomUUID()}_320.webp`;
    storage.seed(thumbKey, 300, new Date(Date.now() - 30 * DAY_MS));

    const report = await service(
      storage,
      fakeDb({
        referenced: [{ objectKey: uploadKey(), thumb320Key: thumbKey, thumb640Key: null }],
      }),
    ).cleanupQueryUploads();

    expect(report.skippedReferenced).toBe(1);
    expect(report.deleted).toBe(0);
    expect(storage.has(thumbKey)).toBe(true);
  });

  it("保留期可配置：短保留期会释放刚过期的对象", async () => {
    const storage = new MemoryStorage();
    const twoDaysOld = uploadKey();
    storage.seed(twoDaysOld, 300, new Date(Date.now() - 2 * DAY_MS));

    const kept = await service(storage).cleanupQueryUploads();
    expect(kept.deleted).toBe(0);

    const report = await service(storage).cleanupQueryUploads({ retentionHours: 24 });
    expect(report.deleted).toBe(1);
    expect(storage.has(twoDaysOld)).toBe(false);
  });

  it("存储没给 lastModified 时不删（无法判断年龄就保守保留）", async () => {
    const storage = new MemoryStorage();
    const unknown = uploadKey();
    storage.seed(unknown, 100, null);

    const report = await service(storage).cleanupQueryUploads();

    expect(report.skippedUnknownAge).toBe(1);
    expect(report.deleted).toBe(0);
    expect(storage.has(unknown)).toBe(true);
  });

  it("幂等：删过之后再跑一次没有可删对象，且不碰其它前缀", async () => {
    const storage = new MemoryStorage();
    const old = uploadKey();
    const sampleObject = sampleKey();
    const receipt = `tenant/${TENANT_ID}/receipts/${randomUUID()}/${randomUUID()}.jpg`;
    storage.seed(old, 100, new Date(Date.now() - 30 * DAY_MS));
    storage.seed(sampleObject, 100, new Date(Date.now() - 30 * DAY_MS));
    storage.seed(receipt, 100, new Date(Date.now() - 30 * DAY_MS));

    const first = await service(storage).cleanupQueryUploads();
    expect(first.deleted).toBe(1);

    const second = await service(storage).cleanupQueryUploads();
    expect(second.listed).toBe(0);
    expect(second.deleted).toBe(0);

    // samples/ 由孤儿回收负责，receipts/ 是回款凭证：这里都不得删除。
    expect(storage.has(sampleObject)).toBe(true);
    expect(storage.has(receipt)).toBe(true);
  });
});

describe("破坏性清理的租户上下文自检（B2）", () => {
  it("受 RLS 约束但未设置 app.tenant_id → 孤儿回收拒绝执行，对象全保留", async () => {
    const storage = new MemoryStorage();
    const object = sampleKey();
    storage.seed(object, 100, new Date(Date.now() - 30 * DAY_MS));

    const maintenance = service(storage, fakeDb({ tenantSetting: null, bypassesRls: false }));
    await expect(maintenance.cleanupOrphanedObjects({ graceHours: 24 })).rejects.toThrow(
      /app\.tenant_id/,
    );
    expect(storage.has(object)).toBe(true);
  });

  it("受 RLS 约束但租户会话指向别的租户 → 查询图回收同样拒绝", async () => {
    const storage = new MemoryStorage();
    const object = uploadKey();
    storage.seed(object, 100, new Date(Date.now() - 30 * DAY_MS));

    const maintenance = service(
      storage,
      fakeDb({ tenantSetting: "99999999-9999-4999-8999-999999999999" }),
    );
    await expect(maintenance.cleanupQueryUploads()).rejects.toThrow(/app\.tenant_id/);
    expect(storage.has(object)).toBe(true);
  });

  it("BYPASSRLS/SUPERUSER 连接无需租户会话即可清理（引用集合完整）", async () => {
    const storage = new MemoryStorage();
    const object = sampleKey();
    storage.seed(object, 100, new Date(Date.now() - 30 * DAY_MS));

    const report = await service(
      storage,
      fakeDb({ tenantSetting: null, bypassesRls: true }),
    ).cleanupOrphanedObjects({ graceHours: 24 });
    expect(report.deleted).toBe(1);
    expect(storage.has(object)).toBe(false);
  });
});
