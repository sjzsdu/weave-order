/**
 * 存量媒体治理 CLI（WAN-125）。
 *
 * 用法：
 *   pnpm --filter @weave-order/api maintain:media -- --dry-run         # 四件事全干跑
 *   pnpm --filter @weave-order/api maintain:media                      # 补派生 + 压原图 + 清孤儿 + 清查询图
 *   pnpm --filter @weave-order/api maintain:media -- --tenant=<uuid>
 *   pnpm --filter @weave-order/api maintain:media -- --skip-compress --skip-orphans --skip-uploads
 *   pnpm --filter @weave-order/api maintain:media -- --force   # 缩略图强制重派（换尺寸/质量后）
 *   pnpm --filter @weave-order/api maintain:media -- --max-original-bytes=2097152 --grace-hours=24
 *   pnpm --filter @weave-order/api maintain:media -- --uploads-retention-days=7
 *
 * 四个动作都可重复执行（幂等）：
 * - 补派生只看 `thumb_status != ready`；
 * - 重编码只看 `byte_size > 阈值`，原 key 不变（覆盖写，不做版本管理）；
 * - 孤儿只删「桶里有、DB 里没有、且超过保护期」的样品对象；
 * - 查询图（`uploads/`）只删「超过保留期」的对象（默认 7 天，不入库、无法按引用反查）。
 *
 * 干跑会真实读对象并计算压缩收益，但不写库、不写桶、不删对象；
 * 每项都会先打印「条数与字节」，再打印实际删除数/字节。
 */
import path from "node:path";
import { Pool } from "pg";
import { createDb } from "@weave-order/db";
import { loadEnv } from "../src/platform/env";
import { createObjectStorageFromEnv } from "../src/platform/storage";
import { MediaMaintenanceService } from "../src/kernel/media-maintenance.service";
import { SampleThumbService } from "../src/kernel/sample-thumbs.service";

try {
  process.loadEnvFile(path.resolve(__dirname, "../../../.env"));
} catch {
  // 没有 .env 就用默认值（本地 MinIO + 默认库）。
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function numberArg(name: string): number | undefined {
  const raw = argValue(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} 必须是正数：${raw}`);
  return value;
}

/** 报告里的字节数统一按 MB 展示，避免「删了 1.2 亿字节」这种看不出量级的输出。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const storage = createObjectStorageFromEnv(env);
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
  const { db, pool } = createDb(databaseUrl);
  const probe = new Pool({ connectionString: databaseUrl, max: 1 });

  const dryRun = hasFlag("dry-run");
  const skipThumbs = hasFlag("skip-thumbs");
  const skipCompress = hasFlag("skip-compress");
  const skipOrphans = hasFlag("skip-orphans");
  const skipUploads = hasFlag("skip-uploads");
  const forceThumbs = hasFlag("force");
  const limit = numberArg("limit") ?? 500;
  const maxOriginalBytes = numberArg("max-original-bytes");
  const graceHours = numberArg("grace-hours");
  const uploadsRetentionDays = numberArg("uploads-retention-days") ?? 7;
  // 显式传 0 等于「删当天上传的查询图」，正在找样的用户会直接失败；保留期必须是正数。
  if (uploadsRetentionDays <= 0) {
    throw new Error("--uploads-retention-days 必须大于 0（默认 7 天）");
  }

  try {
    const tenantArg = argValue("tenant");
    let tenantIds: string[];
    if (tenantArg) {
      tenantIds = [tenantArg];
    } else {
      const rows = await probe.query<{ id: string }>("SELECT id FROM tenants ORDER BY created_at");
      tenantIds = rows.rows.map((row) => row.id);
    }

    if (tenantIds.length === 0) {
      console.log("没有租户，跳过。");
      return;
    }
    console.log(
      `媒体治理：租户 ${tenantIds.length} 个，模式=${dryRun ? "干跑（不写）" : "执行"}` +
        `，每项上限 ${limit} 条`,
    );

    let failed = 0;
    for (const tenantId of tenantIds) {
      const thumbs = new SampleThumbService(db, tenantId, storage);
      const maintenance = new MediaMaintenanceService(db, tenantId, storage, thumbs);
      console.log(`\n== 租户 ${tenantId}`);
      const counts = await maintenance.counts();
      console.log(
        `   图片 ${counts.images} 张；缩略图待派生 ${counts.thumbsPending}；` +
          `超大原图（>2MB）${counts.oversized}`,
      );

      if (!skipThumbs) {
        const report = await maintenance.backfillThumbs({ dryRun, limit, force: forceThumbs });
        failed += report.failed.length;
        console.log(
          `   缩略图：待派生 ${report.pending}，本次派生 ${report.derived}` +
            `，失败 ${report.failed.length}${dryRun ? "（干跑未写入）" : ""}`,
        );
        for (const failure of report.failed.slice(0, 5)) {
          console.log(`     ! 图片 ${failure.imageId}：${failure.message.slice(0, 200)}`);
        }
        if (!dryRun) {
          const after = await thumbs.statusCounts();
          console.log(
            `   缩略图状态：ready ${after.ready} / pending ${after.pending} / failed ${after.failed}`,
          );
        }
      }

      if (!skipCompress) {
        const report = await maintenance.compressOversizedOriginals({
          dryRun,
          limit,
          thresholdBytes: maxOriginalBytes,
        });
        failed += report.failures.length;
        console.log(
          `   原图重编码：扫描 ${report.scanned}，` +
            `${dryRun ? "可压缩" : "已压缩"} ${report.compressed}，跳过 ${report.skipped}，` +
            `预计/实际节省 ${(report.savedBytes / 1024 / 1024).toFixed(2)} MB` +
            `，失败 ${report.failures.length}`,
        );
        for (const failure of report.failures.slice(0, 5)) {
          console.log(`     ! 图片 ${failure.imageId}：${failure.message.slice(0, 200)}`);
        }
      }

      if (!skipOrphans) {
        const report = await maintenance.cleanupOrphanedObjects({ dryRun, graceHours });
        failed += report.failures.length;
        console.log(
          `   孤儿对象：列举 ${report.listed} 个 / ${formatBytes(report.listedBytes)}，` +
            `DB 引用 ${report.referenced}，` +
            `${dryRun ? "可删除" : "已删除"} ${dryRun ? report.candidates : report.deleted} 个 / ` +
            `${formatBytes(dryRun ? report.candidateBytes : report.deletedBytes)}，` +
            `保护期内 ${report.skippedWithinGrace}，年龄未知 ${report.skippedUnknownAge}` +
            `，失败 ${report.failures.length}`,
        );
        for (const failure of report.failures.slice(0, 5)) {
          console.log(`     ! 对象 ${failure.key}：${failure.message.slice(0, 200)}`);
        }
      }

      if (!skipUploads) {
        const report = await maintenance.cleanupQueryUploads({
          dryRun,
          retentionHours: uploadsRetentionDays * 24,
        });
        failed += report.failures.length;
        console.log(
          `   查询图（uploads/）：列举 ${report.listed} 个 / ${formatBytes(report.listedBytes)}，` +
            `${dryRun ? "可删除" : "已删除"} ${dryRun ? report.candidates : report.deleted} 个 / ` +
            `${formatBytes(dryRun ? report.candidateBytes : report.deletedBytes)}，` +
            `保留期（${uploadsRetentionDays} 天）内 ${report.skippedWithinRetention}，` +
            `年龄未知 ${report.skippedUnknownAge}，失败 ${report.failures.length}`,
        );
        for (const failure of report.failures.slice(0, 5)) {
          console.log(`     ! 对象 ${failure.key}：${failure.message.slice(0, 200)}`);
        }
      }
    }

    if (failed > 0) {
      console.error(`\n✖ 有 ${failed} 项失败；修好原因后重跑本命令（幂等，只会处理剩下的）。`);
      process.exitCode = 1;
    } else {
      console.log("\n✔ 媒体治理完成");
    }
  } finally {
    await pool.end();
    await probe.end();
  }
}

void main().catch((error: unknown) => {
  console.error("✖ 媒体治理失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
