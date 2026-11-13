-- 控制面附加约束（Drizzle 无法表达的部分）。
-- 幂等：每次 migrate:platform 都重新套用。

-- 平台审计只追加：任何 UPDATE / DELETE 直接拒绝。
CREATE OR REPLACE FUNCTION control.reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'control.% 只允许追加，禁止 % 操作', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_audit_append_only ON control.platform_audit;
CREATE TRIGGER platform_audit_append_only
  BEFORE UPDATE OR DELETE ON control.platform_audit
  FOR EACH ROW EXECUTE FUNCTION control.reject_mutation();

-- 发票号序列所有权（生成列默认值兜底；应用层也会显式取号）。
CREATE SEQUENCE IF NOT EXISTS control.invoice_number_seq START WITH 1000;
