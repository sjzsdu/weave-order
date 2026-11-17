-- 控制面默认配置：套餐 + 初始价格表（幂等，每次 migrate:platform 重新套用）。
--
-- 为什么放在迁移里而不是 seed：`platform:seed` 带生产闸门（演示人员/演示租户不允许进生产库），
-- 结果全新生产环境迁移完是「空控制面」——没有套餐就无法开通租户、无法建价格表。
-- 默认套餐是控制面运行的必需配置（不是演示数据），因此随迁移写入。
--
-- 幂等口径：已存在的行一律不覆盖，运营调整过的套餐与价格不会被部署回滚。

INSERT INTO control.plans
  (code, name, tier, seat_min, seat_max, agent_actions_quota, storage_gb, features, status)
VALUES
  ('TRIAL', '试用 Trial', 0, 3, 3, 2000, 5,
   '{"customer_portal": false, "sso": false, "custom_domain": false, "print_agent": false}'::jsonb, 'ACTIVE'),
  ('STARTER', '基础 Starter', 1, 5, 5, 20000, 50,
   '{"customer_portal": true, "sso": false, "custom_domain": false, "print_agent": false}'::jsonb, 'ACTIVE'),
  ('PRO', '专业 Pro', 2, 20, 20, 100000, 200,
   '{"customer_portal": true, "sso": true, "custom_domain": true, "print_agent": true}'::jsonb, 'ACTIVE'),
  ('ENTERPRISE', '企业 Enterprise', 3, 50, 100000, 500000, 1000,
   '{"customer_portal": true, "sso": true, "custom_domain": true, "print_agent": true}'::jsonb, 'ACTIVE')
ON CONFLICT (code) DO NOTHING;

-- 初始价格表：只在完全没有价格版本时创建，避免把运营已经建好的版本体系打乱。
INSERT INTO control.price_books (version, status, effective_from, notes, created_by, activated_at)
SELECT 1, 'ACTIVE', now(), '初始价格表（部署自带；改价请新建版本并走双人复核）', 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM control.price_books);

-- 只补 v1 缺失的套餐价，不覆盖任何已有价格。
INSERT INTO control.plan_prices
  (price_book_id, plan_code, monthly_price_cents, annual_price_cents, currency)
SELECT b.id, p.plan_code, p.monthly_price_cents, p.annual_price_cents, 'CNY'
FROM control.price_books b
CROSS JOIN (VALUES
  ('TRIAL', 0, 0),
  ('STARTER', 29900, 299000),
  ('PRO', 89900, 899000),
  ('ENTERPRISE', 299900, 2999000)
) AS p(plan_code, monthly_price_cents, annual_price_cents)
WHERE b.version = 1
ON CONFLICT (price_book_id, plan_code) DO NOTHING;
