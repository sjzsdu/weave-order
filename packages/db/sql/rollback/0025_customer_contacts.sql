-- WAN-177 · P2 多联系人 回滚
--
-- 注意：回填出来的联系人行是「旧三列的副本」，本批旧三列未删除，
-- 因此反迁移只需丢掉子表与外发记录的新列，业务数据（客户档案）无损。
-- 顺序：先删外发记录引用，再删表，最后清掉 contact.role 预置项。
BEGIN;

ALTER TABLE "quote_shares" DROP CONSTRAINT IF EXISTS "quote_shares_contact_id_customer_contacts_id_fk";
DROP INDEX IF EXISTS "quote_shares_tenant_contact_idx";
ALTER TABLE "quote_shares" DROP COLUMN IF EXISTS "contact_snapshot";
ALTER TABLE "quote_shares" DROP COLUMN IF EXISTS "contact_id";

DROP TABLE IF EXISTS "customer_contacts";

DELETE FROM "field_options" WHERE "field_key" = 'contact.role';

COMMIT;
