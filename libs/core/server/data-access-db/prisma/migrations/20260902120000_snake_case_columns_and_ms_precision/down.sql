-- Down migration for 20260902120000_snake_case_columns_and_ms_precision.
-- Skeleton from tools/prisma-down.ts, then rewritten: the diff rendered every
-- rename as DROP + ADD, which would throw the data away. The reverse of a
-- RENAME is a RENAME.
--
-- Widening back to TIMESTAMPTZ(6) is lossless; the milliseconds stored under
-- (3) are still exact under (6).

ALTER INDEX "idempotency_records_scope_type_scope_id_route_idempotency_k_key"
  RENAME TO "idempotency_records_scopeType_scopeId_route_idempotencyKey_key";
ALTER INDEX "idempotency_records_completed_at_idx" RENAME TO "idempotency_records_completedAt_idx";

ALTER TABLE "idempotency_records"
  ALTER COLUMN "started_at" TYPE TIMESTAMPTZ(6),
  ALTER COLUMN "lease_until" TYPE TIMESTAMPTZ(6),
  ALTER COLUMN "completed_at" TYPE TIMESTAMPTZ(6);

ALTER TABLE "idempotency_records" RENAME COLUMN "completed_at" TO "completedAt";
ALTER TABLE "idempotency_records" RENAME COLUMN "fence_token" TO "fenceToken";
ALTER TABLE "idempotency_records" RENAME COLUMN "lease_until" TO "leaseUntil";
ALTER TABLE "idempotency_records" RENAME COLUMN "started_at" TO "startedAt";
ALTER TABLE "idempotency_records" RENAME COLUMN "response_body" TO "responseBody";
ALTER TABLE "idempotency_records" RENAME COLUMN "response_status" TO "responseStatus";
ALTER TABLE "idempotency_records" RENAME COLUMN "request_hash" TO "requestHash";
ALTER TABLE "idempotency_records" RENAME COLUMN "idempotency_key" TO "idempotencyKey";
ALTER TABLE "idempotency_records" RENAME COLUMN "scope_id" TO "scopeId";
ALTER TABLE "idempotency_records" RENAME COLUMN "scope_type" TO "scopeType";

ALTER INDEX "demo_items_created_at_id_idx" RENAME TO "demo_items_createdAt_id_idx";

ALTER TABLE "demo_items"
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(6),
  ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6);

ALTER TABLE "demo_items" RENAME COLUMN "updated_at" TO "updatedAt";
ALTER TABLE "demo_items" RENAME COLUMN "created_at" TO "createdAt";
