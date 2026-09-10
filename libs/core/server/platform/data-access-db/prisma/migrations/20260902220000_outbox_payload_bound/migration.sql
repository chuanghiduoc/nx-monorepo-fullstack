-- Makes the database's payload bound measure what the application's does.
--
-- The two were written to the same number and not to the same quantity.
-- `append()` bounds `Buffer.byteLength(JSON.stringify(payload))`; the original
-- constraint bounded `pg_column_size(payload)`, which is the *stored* size of
-- the jsonb — per-entry binary headers for a many-keyed object, and the
-- compressed length once the value is large enough for PostgreSQL to compress
-- it. Measured on PostgreSQL 18: a value whose text is 33 786 bytes stores as
-- 15 112.
--
-- So the two disagree in both directions, and the direction that matters is a
-- payload the application accepts and the constraint refuses: the refusal
-- arrives as a bare constraint violation inside the caller's transaction, which
-- rolls back the user's write — precisely the failure the application-side
-- check exists to turn into a message naming the aggregate.
--
-- `octet_length(payload::text)` is the same quantity the application measures.
ALTER TABLE "outbox_events" DROP CONSTRAINT "outbox_events_payload_size";

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_payload_size"
  CHECK (octet_length("payload"::text) <= 65536);
