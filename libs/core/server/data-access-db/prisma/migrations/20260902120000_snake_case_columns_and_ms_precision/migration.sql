-- Written with --create-only on purpose.
--
-- `prisma migrate diff` renders a rename as DROP + ADD, which would throw the
-- data away. RENAME COLUMN keeps it, holds a lock only long enough to update
-- the catalog, and never rewrites the table.
--
-- The type change is TIMESTAMPTZ(6) -> TIMESTAMPTZ(3). PostgreSQL stores
-- microseconds; JavaScript Date carries milliseconds. A keyset cursor built
-- from a truncated timestamp never matches its own row again, so the equality
-- branch of the comparison silently skips every row sharing that millisecond.
-- Verified against this database before the change: a row stored at
--.123456 read back as.123 and did not match a query for.123.

-- demo_items
ALTER TABLE "demo_items" RENAME COLUMN "createdAt" TO "created_at";
ALTER TABLE "demo_items" RENAME COLUMN "updatedAt" TO "updated_at";

ALTER TABLE "demo_items"
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3),
  ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(3);

ALTER INDEX "demo_items_createdAt_id_idx" RENAME TO "demo_items_created_at_id_idx";

-- idempotency_records
ALTER TABLE "idempotency_records" RENAME COLUMN "scopeType" TO "scope_type";
ALTER TABLE "idempotency_records" RENAME COLUMN "scopeId" TO "scope_id";
ALTER TABLE "idempotency_records" RENAME COLUMN "idempotencyKey" TO "idempotency_key";
ALTER TABLE "idempotency_records" RENAME COLUMN "requestHash" TO "request_hash";
ALTER TABLE "idempotency_records" RENAME COLUMN "responseStatus" TO "response_status";
ALTER TABLE "idempotency_records" RENAME COLUMN "responseBody" TO "response_body";
ALTER TABLE "idempotency_records" RENAME COLUMN "startedAt" TO "started_at";
ALTER TABLE "idempotency_records" RENAME COLUMN "leaseUntil" TO "lease_until";
ALTER TABLE "idempotency_records" RENAME COLUMN "fenceToken" TO "fence_token";
ALTER TABLE "idempotency_records" RENAME COLUMN "completedAt" TO "completed_at";

ALTER TABLE "idempotency_records"
  ALTER COLUMN "started_at" TYPE TIMESTAMPTZ(3),
  ALTER COLUMN "lease_until" TYPE TIMESTAMPTZ(3),
  ALTER COLUMN "completed_at" TYPE TIMESTAMPTZ(3);

ALTER INDEX "idempotency_records_completedAt_idx" RENAME TO "idempotency_records_completed_at_idx";
ALTER INDEX "idempotency_records_scopeType_scopeId_route_idempotencyKey_key"
  RENAME TO "idempotency_records_scope_type_scope_id_route_idempotency_k_key";
