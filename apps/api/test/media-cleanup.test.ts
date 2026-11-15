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
 * 查询图（`tenant/<tid>/uploads/`）回收（WAN-130）。
 *
 * 只测「按前缀与保留期删除」这一个动作，不需要数据库：
 * 查询图本来就不入库，所以这个方法的判据只有对象年龄，
 * 用内存实现就能把「保护期内不删 / 年龄未知不删 / 干跑不删 / 幂等」全部验证掉。
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

function service(storage: ObjectStorage): MediaMaintenanceService {
  // cleanupQueryUploads 不读 DB、不碰缩略图；显式传 null 而不是造假对象，避免以后误用。
  return new MediaMaintenanceService(
    null as unknown as Db,
    TENANT_ID,
    storage,
    null as unknown as SampleThumbService,
  );
}

function uploadKey(): string {
  return `tenant/${TENANT_ID}/uploads/${randomUUID()}.jpg`;
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
    const sampleObject = `tenant/${TENANT_ID}/samples/${randomUUID()}/${randomUUID()}.jpg`;
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
