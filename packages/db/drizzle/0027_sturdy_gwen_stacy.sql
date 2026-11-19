-- WAN-179 · P3 操作日志
--
-- 1) 审计导出任务表（异步导出：建 job → 轮询 → 短期下载链接）
-- 2) audit_log 改为按月 RANGE 分区（created_at），在线保留 24 个月
-- 3) 日志页的筛选/游标索引
-- 4) 分区维护函数：建未来分区、把 default 分区里的行搬回正确分区、drop 超期分区
--
-- 迁移顺序：先停掉旧表上的 FORCE RLS（owner 也需要看到全部存量行才能搬迁），
-- 再建分区父表与 default 分区，按月建好历史分区，最后一次性搬数据。
-- 旧表在搬迁完成后删除；触发器在父表上重建（PG16 行触发器自动下推到各分区）。

CREATE TABLE "audit_export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requested_by" varchar(128) NOT NULL,
	"requested_by_name" varchar(128),
	"requested_by_role" varchar(32),
	"status" varchar(16) DEFAULT 'PENDING' NOT NULL,
	"filter" jsonb NOT NULL,
	"row_count" integer,
	"object_key" varchar(512),
	"file_name" varchar(255),
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_export_jobs_tenant_created_idx" ON "audit_export_jobs" USING btree ("tenant_id","created_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- audit_log → 按月 RANGE 分区
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_log" RENAME TO "audit_log_legacy";--> statement-breakpoint
-- 索引跟随表改名保留旧名字；新父表要建同名索引，先把旧表的索引让开。
ALTER INDEX IF EXISTS "audit_log_tenant_entity_idx" RENAME TO "audit_log_legacy_tenant_entity_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "audit_log_created_at_idx" RENAME TO "audit_log_legacy_created_at_idx";--> statement-breakpoint
ALTER SEQUENCE "audit_log_seq_seq" OWNED BY NONE;--> statement-breakpoint
-- 迁移需要读到全部租户的行；FORCE RLS 下连 owner 也受策略约束。
ALTER TABLE "audit_log_legacy" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "audit_log" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"seq" bigint DEFAULT nextval('audit_log_seq_seq') NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" varchar(128) NOT NULL,
	"actor_role" "member_role",
	"actor_name" varchar(128),
	"entity_label" varchar(255),
	"action" varchar(64) NOT NULL,
	"entity_type" varchar(64) NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"correlation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_id_created_at_pk" PRIMARY KEY("id","created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint

-- DEFAULT 分区是最后一道保险：定时任务万一没跑，写入也不会因为缺分区而失败。
CREATE TABLE "audit_log_default" PARTITION OF "audit_log" DEFAULT;--> statement-breakpoint

CREATE UNIQUE INDEX "audit_log_seq_created_at_uq" ON "audit_log" USING btree ("seq","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_entity_idx" ON "audit_log" USING btree ("tenant_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_created_seq_idx" ON "audit_log" USING btree ("tenant_id","created_at" DESC NULLS LAST,"seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_tenant_seq_idx" ON "audit_log" USING btree ("tenant_id","seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_tenant_actor_idx" ON "audit_log" USING btree ("tenant_id","actor_id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_action_idx" ON "audit_log" USING btree ("tenant_id","action");--> statement-breakpoint

-- 历史分区：从最早的审计行到未来 3 个月，逐月建好后再搬数据（直接插入会按
-- created_at 落到正确分区，不会全部堆在 default）。
DO $$
DECLARE
  start_month date;
  cursor_month date;
  part_name text;
BEGIN
  SELECT date_trunc('month', COALESCE(MIN("created_at"), now()))::date
    INTO start_month
    FROM "audit_log_legacy";
  cursor_month := start_month;
  WHILE cursor_month <= date_trunc('month', now() + interval '3 months')::date LOOP
    part_name := 'audit_log_p' || to_char(cursor_month, 'YYYYMM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "audit_log" FOR VALUES FROM (%L) TO (%L)',
      part_name,
      cursor_month::text || ' 00:00:00+08',
      ((cursor_month + interval '1 month')::date)::text || ' 00:00:00+08'
    );
    cursor_month := (cursor_month + interval '1 month')::date;
  END LOOP;
END $$;--> statement-breakpoint

INSERT INTO "audit_log" (
  "id", "tenant_id", "seq", "actor_type", "actor_id", "actor_role", "actor_name",
  "entity_label", "action", "entity_type", "entity_id", "before", "after",
  "correlation_id", "created_at"
)
SELECT
  "id", "tenant_id", "seq", "actor_type", "actor_id", "actor_role", "actor_name",
  "entity_label", "action", "entity_type", "entity_id", "before", "after",
  "correlation_id", "created_at"
FROM "audit_log_legacy"
ORDER BY "seq";--> statement-breakpoint

-- seq 是全局单调序：搬迁沿用原值后把序列推到当前最大值，避免新行撞号。
SELECT setval('audit_log_seq_seq', GREATEST((SELECT COALESCE(MAX("seq"), 0) FROM "audit_log"), 1));--> statement-breakpoint
ALTER SEQUENCE "audit_log_seq_seq" OWNED BY "audit_log"."seq";--> statement-breakpoint

DROP TABLE "audit_log_legacy";--> statement-breakpoint

-- 触发器在父表上重建（0001 / 0012 建在旧表上，随旧表一起销毁）。
DROP TRIGGER IF EXISTS "weave_audit_log_no_update" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "weave_audit_log_no_update"
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "weave_audit_log_append_only"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "weave_audit_log_no_delete" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "weave_audit_log_no_delete"
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "weave_audit_log_append_only"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "weave_audit_log_no_truncate" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "weave_audit_log_no_truncate"
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "weave_audit_log_append_only"();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 分区维护：建下月分区 + drop 超期分区
-- ---------------------------------------------------------------------------

/**
 * 确保某个月的分区存在。
 *
 * default 分区里如果已经有本该属于这个月的行（例如定时任务晚跑），先摘下来、
 * 临时关掉 append-only 的 DELETE 触发器把这几行搬进新分区，再挂回去。
 * 只在维护窗口执行，行数等于「漏建分区期间写入的审计」。
 */
CREATE OR REPLACE FUNCTION weave_audit_log_ensure_partition(p_month date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name text := 'audit_log_p' || to_char(date_trunc('month', p_month), 'YYYYMM');
  v_default_attached boolean := false;
BEGIN
  IF to_regclass(v_name) IS NOT NULL THEN
    RETURN v_name;
  END IF;

  -- 默认分区里可能已经有这个月的行；有重叠行时 CREATE PARTITION 会直接失败，
  -- 所以先摘下来，建好分区、把行搬进去，再挂回去。窗口只在这个函数的事务内。
  IF to_regclass('audit_log_default') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM pg_inherits
      WHERE inhparent = 'audit_log'::regclass
        AND inhrelid = 'audit_log_default'::regclass
    ) INTO v_default_attached;
    IF v_default_attached THEN
      ALTER TABLE audit_log DETACH PARTITION audit_log_default;
    END IF;
  END IF;

  EXECUTE format(
    'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
    v_name, v_start::text || ' 00:00:00+08', v_end::text || ' 00:00:00+08'
  );

  IF v_default_attached THEN
    -- append-only 的 DELETE 触发器在父表上；只在本函数事务内临时关闭。
    ALTER TABLE audit_log DISABLE TRIGGER weave_audit_log_no_delete;
    INSERT INTO audit_log (
      id, tenant_id, seq, actor_type, actor_id, actor_role, actor_name,
      entity_label, action, entity_type, entity_id, before, after,
      correlation_id, created_at
    )
    SELECT
      id, tenant_id, seq, actor_type, actor_id, actor_role, actor_name,
      entity_label, action, entity_type, entity_id, before, after,
      correlation_id, created_at
    FROM audit_log_default
    WHERE created_at >= v_start AND created_at < v_end;
    DELETE FROM audit_log_default
    WHERE created_at >= v_start AND created_at < v_end;
    ALTER TABLE audit_log ENABLE TRIGGER weave_audit_log_no_delete;
    ALTER TABLE audit_log ATTACH PARTITION audit_log_default DEFAULT;
  END IF;

  RETURN v_name;
END;
$$;--> statement-breakpoint

/**
 * 分区维护入口（由 `pnpm --filter @weave-order/api maintain:audit` 定时调用）：
 * - 建好本月 + 未来 `p_ahead_months` 个月的分区；
 * - drop 掉整月都早于「今天 - 24 个月」的分区。
 * 返回被 drop 的分区数。
 */
CREATE OR REPLACE FUNCTION weave_audit_log_maintain(
  p_retention_months integer DEFAULT 24,
  p_ahead_months integer DEFAULT 3
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  i integer;
  v_cutoff date := (date_trunc('month', now()) - make_interval(months => p_retention_months))::date;
  v_part record;
  v_dropped integer := 0;
  v_month date;
BEGIN
  FOR i IN 0..p_ahead_months LOOP
    PERFORM weave_audit_log_ensure_partition(
      (date_trunc('month', now()) + make_interval(months => i))::date
    );
  END LOOP;

  FOR v_part IN
    SELECT child.relname AS name
    FROM pg_inherits
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    WHERE parent.relname = 'audit_log'
      AND child.relname ~ '^audit_log_p[0-9]{6}$'
  LOOP
    v_month := to_date(substr(v_part.name, 12, 6), 'YYYYMM');
    -- 整个月都早于保留边界才 drop，绝不切掉边界月的一部分。
    IF (v_month + interval '1 month')::date <= v_cutoff THEN
      EXECUTE format('DROP TABLE %I', v_part.name);
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;

  RETURN v_dropped;
END;
$$;
