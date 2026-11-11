-- 审计日志只允许追加：UPDATE / DELETE 一律由数据库拒绝。
-- 这是「内核改账必须留痕」的最后一道物理防线，即使有人拿到 SQL 权限也改不了历史。
CREATE OR REPLACE FUNCTION weave_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER weave_audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION weave_audit_log_append_only();
--> statement-breakpoint
CREATE TRIGGER weave_audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION weave_audit_log_append_only();
