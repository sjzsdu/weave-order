-- =============================================================================
-- WeaveOrder · P0 多租户行级隔离（幂等，可重复执行）
--
-- 依赖：0003 迁移已给所有业务表加 tenant_id。
-- 应用角色：weave_app（无 SUPERUSER、无 BYPASSRLS），只能看到
-- current_setting('app.tenant_id') 对应的行。
--
-- 开发/CI 默认口令 weave_app；生产必须在部署时轮换并改走密钥管理。
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'weave_app') THEN
    CREATE ROLE weave_app LOGIN PASSWORD 'weave_app';
  END IF;
END $$;

ALTER ROLE weave_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO weave_app;

-- 只授予业务表与租户/成员表的 DML 权限；LangGraph checkpoint 等内部表不开放。
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants,
  memberships,
  customers,
  customer_contexts,
  samples,
  sample_embeddings,
  sample_shipments,
  sample_shipment_items,
  quotes,
  quote_items,
  orders,
  order_items,
  shipments,
  shipment_items,
  receivables,
  revision_reasons,
  revision_requests,
  draft_revisions,
  quote_shares,
  quote_share_events,
  audit_log
TO weave_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO weave_app;

-- 业务表：tenant_id = 会话租户。缺省/空设置时 NULL 比较为 false，一律拒绝。
DO $$
DECLARE
  t text;
  business_tables text[] := ARRAY[
    'memberships',
    'customers',
    'customer_contexts',
    'samples',
    'sample_embeddings',
    'sample_shipments',
    'sample_shipment_items',
    'quotes',
    'quote_items',
    'orders',
    'order_items',
    'shipments',
    'shipment_items',
    'receivables',
    'revision_reasons',
    'revision_requests',
    'draft_revisions',
    'quote_shares',
    'quote_share_events',
    'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY business_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- 租户表本身以主键作为隔离键（开通租户时会话已切到新租户 id）。
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.tenants;
CREATE POLICY tenant_isolation ON public.tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 审计表额外保持只追加（触发器已在 0001 迁移创建）。
ALTER TABLE public.audit_log ENABLE TRIGGER USER;
