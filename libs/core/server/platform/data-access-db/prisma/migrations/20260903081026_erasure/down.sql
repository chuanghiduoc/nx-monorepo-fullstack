-- Reverses the erasure grants and the soft-delete columns.
--
-- The grants are revoked explicitly because they were made on tables this
-- migration did not create — dropping a column does not take them with it.
REVOKE UPDATE ("actor_id", "detail") ON "audit_records" FROM erasure_role;
REVOKE SELECT ON "audit_records" FROM erasure_role;
REVOKE SELECT, DELETE ON "user", "organization" FROM erasure_role;

DROP INDEX IF EXISTS "audit_records_actor_id_idx";
DROP INDEX IF EXISTS "organization_deleted_at_idx";
DROP INDEX IF EXISTS "user_deleted_at_idx";

ALTER TABLE "organization" DROP COLUMN IF EXISTS "deleted_at";
ALTER TABLE "user" DROP COLUMN IF EXISTS "deleted_at";
