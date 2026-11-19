-- WAN-178 · P1 字段选项
--
-- 为存量租户补齐品类 / 成分 / 联系人角色的推荐项。
-- 0024 只种了等级；新建租户由 createTenant 同事务种子（DEFAULT_FIELD_OPTIONS），
-- 本迁移覆盖「P0 之前就存在」的公司，幂等可重复执行。

INSERT INTO "field_options" ("tenant_id", "field_key", "code", "label", "normalized", "sort_order")
SELECT t."id", v."field_key", v."code", v."label", v."normalized", v."sort_order"
FROM "tenants" t
CROSS JOIN (VALUES
  ('sample.category',    'CAT-KNIT',        '针织',      '针织',      10),
  ('sample.category',    'CAT-WOVEN',       '梭织',      '梭织',      20),
  ('sample.category',    'CAT-NONWOVEN',    '无纺',      '无纺',      30),
  ('sample.category',    'CAT-YARNDYE',     '色织',      '色织',      40),
  ('sample.category',    'CAT-PRINT',       '印花',      '印花',      50),
  ('sample.composition', 'COMP-COTTON',     '100% 棉',   '100% 棉',   10),
  ('sample.composition', 'COMP-POLYESTER',  '100% 涤纶', '100% 涤纶', 20),
  ('sample.composition', 'COMP-COTTON-POLY','棉涤混纺',  '棉涤混纺',  30),
  ('sample.composition', 'COMP-LINEN',      '100% 亚麻', '100% 亚麻', 40),
  ('sample.composition', 'COMP-SILK',       '100% 真丝', '100% 真丝', 50),
  ('contact.role',       'ROLE-PURCHASING', '采购',      '采购',      10),
  ('contact.role',       'ROLE-FINANCE',    '财务',      '财务',      20),
  ('contact.role',       'ROLE-MERCHANDISER','跟单',     '跟单',      30)
) AS v("field_key", "code", "label", "normalized", "sort_order")
ON CONFLICT ("tenant_id", "field_key", "normalized") DO NOTHING;
