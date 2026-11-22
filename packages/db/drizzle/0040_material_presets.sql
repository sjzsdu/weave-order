-- 样品原料字典（配比模式的原料清单）
--
-- 新建租户由 createTenant 同事务种子（DEFAULT_FIELD_OPTIONS），本迁移覆盖
-- 「原料字典这一列出现之前就已经存在」的公司，幂等可重复执行。
--
-- 为什么原料也要补种：配比模式靠原料 code 引用字典，租户没有这张清单时
-- 任何配比都会被判「未知原料」，等于把功能锁死在新建租户上。

INSERT INTO "field_options" ("tenant_id", "field_key", "code", "label", "normalized", "sort_order")
SELECT t."id", v."field_key", v."code", v."label", v."normalized", v."sort_order"
FROM "tenants" t
CROSS JOIN (VALUES
  ('sample.material', 'MAT-COTTON',    '棉',       '棉',       10),
  ('sample.material', 'MAT-POLYESTER', '涤纶',     '涤纶',     20),
  ('sample.material', 'MAT-NYLON',     '锦纶',     '锦纶',     30),
  ('sample.material', 'MAT-ACRYLIC',   '腈纶',     '腈纶',     40),
  ('sample.material', 'MAT-VISCOSE',   '粘胶',     '粘胶',     50),
  ('sample.material', 'MAT-MODAL',     '莫代尔',   '莫代尔',   60),
  ('sample.material', 'MAT-LYOCELL',   '莱赛尔',   '莱赛尔',   70),
  ('sample.material', 'MAT-CUPPRO',    '铜氨',     '铜氨',     80),
  ('sample.material', 'MAT-ACETATE',   '醋酸',     '醋酸',     90),
  ('sample.material', 'MAT-SPANDEX',   '氨纶',     '氨纶',     100),
  ('sample.material', 'MAT-LINEN',     '亚麻',     '亚麻',     110),
  ('sample.material', 'MAT-RAMIE',     '苎麻',     '苎麻',     120),
  ('sample.material', 'MAT-JUTE',      '黄麻',     '黄麻',     130),
  ('sample.material', 'MAT-SILK',      '真丝',     '真丝',     140),
  ('sample.material', 'MAT-WOOL',      '羊毛',     '羊毛',     150),
  ('sample.material', 'MAT-CASHMERE',  '羊绒',     '羊绒',     160),
  ('sample.material', 'MAT-BAMBOO',    '竹纤维',   '竹纤维',   170),
  ('sample.material', 'MAT-RAYON',     '人造丝',   '人造丝',   180)
) AS v("field_key", "code", "label", "normalized", "sort_order")
ON CONFLICT ("tenant_id", "field_key", "normalized") DO NOTHING;
