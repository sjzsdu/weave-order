-- TRUNCATE 不经过行级触发器：0001 的 UPDATE / DELETE 防线之外，还缺这条语句级防线。
-- 原本占 0011，rebase 到上游 `sample_images`（同样编号 0011）之后顺延为 0012；
-- drizzle 只按 `created_at` 与 journal 的 `when` 比较决定是否重放，改号后已建过触发器的库
-- 会再跑一次这条迁移，因此必须先 DROP IF EXISTS 保证幂等。
DROP TRIGGER IF EXISTS weave_audit_log_no_truncate ON audit_log;--> statement-breakpoint
CREATE TRIGGER weave_audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION weave_audit_log_append_only();
