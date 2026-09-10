-- Reverses 'retention_sweep_indexes'.
--
-- Dropping an index is metadata-only and takes an ACCESS EXCLUSIVE lock for
-- the moment it runs; on a live table use DROP INDEX CONCURRENTLY instead,
-- which cannot run inside a transaction and therefore cannot live in this file.
DROP INDEX IF EXISTS "verification_expires_at_idx";
DROP INDEX IF EXISTS "session_expires_at_idx";
DROP INDEX IF EXISTS "idempotency_records_lease_until_idx";
