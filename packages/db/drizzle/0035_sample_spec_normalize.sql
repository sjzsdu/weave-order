-- WAN-204 · 样品规格数据修复
--
-- 1) 存量样品把「100% 棉」录成了「100% 全面」（OCR / 手工录入的形近字）。
--    只修正去掉空白后完全等于「100%全面」的行，不做模糊替换，避免误改自定义配方。
--    不改 updated_at：数据修复不应打乱「最近更新」排序。
UPDATE "samples"
SET "composition" = '100%全棉'
WHERE regexp_replace(coalesce("composition", ''), '\s', '', 'g') = '100%全面';
