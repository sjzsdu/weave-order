-- WAN-179 · 0025 的反迁移（人工执行，不参与 drizzle 自动迁移）
--
-- 把 audit_log 从按月分区还原为普通表，并删除导出任务表。
-- 注意：24 个月保留策略已经 drop 的超期分区数据无法恢复——这是保留策略的
-- 既定后果，回滚只能恢复「当前还在线」的数据。
--
-- 用法：psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/sql/rollback/0025_audit_partition_export.sql

BEGIN;

DROP FUNCTION IF EXISTS weave_audit_log_maintain(integer, integer);
DROP FUNCTION IF EXISTS weave_audit_log_ensure_partition(date);

-- LIKE INCLUDING ALL 复制列、默认值、约束与索引；分区本身不带数据，先搬再删。
CREATE TABLE "audit_log_flat" (LIKE "audit_log" INCLUDING ALL);
INSERT INTO "audit_log_flat"
SELECT * FROM "audit_log";

-- 序列当前 OWNED BY 分区表的列；先解除所有权，否则 DROP TABLE 会因依赖失败。
ALTER SEQUENCE "audit_log_seq_seq" OWNED BY NONE;
DROP TABLE "audit_log";
ALTER TABLE "audit_log_flat" RENAME TO "audit_log";
-- 分区表的主键包含 created_at；还原后只保留 id 主键，避免与旧 schema 漂移。
-- LIKE 复制出来的主键名不一定与原名一致，先按类型找出来再删。
DO $$
DECLARE
  v_pk text;
BEGIN
  SELECT conname INTO v_pk
  FROM pg_constraint
  WHERE conrelid = 'audit_log'::regclass AND contype = 'p';
  IF v_pk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE audit_log DROP CONSTRAINT %I', v_pk);
  END IF;
END $$;
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");
DROP INDEX IF EXISTS "audit_log_seq_created_at_uq";
ALTER SEQUENCE "audit_log_seq_seq" OWNED BY "audit_log"."seq";

DROP TRIGGER IF EXISTS "weave_audit_log_no_update" ON "audit_log";
CREATE TRIGGER "weave_audit_log_no_update"
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "weave_audit_log_append_only"();
DROP TRIGGER IF EXISTS "weave_audit_log_no_delete" ON "audit_log";
CREATE TRIGGER "weave_audit_log_no_delete"
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "weave_audit_log_append_only"();
DROP TRIGGER IF EXISTS "weave_audit_log_no_truncate" ON "audit_log";
CREATE TRIGGER "weave_audit_log_no_truncate"
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "weave_audit_log_append_only"();

DROP TABLE IF EXISTS "audit_export_jobs";

COMMIT;
