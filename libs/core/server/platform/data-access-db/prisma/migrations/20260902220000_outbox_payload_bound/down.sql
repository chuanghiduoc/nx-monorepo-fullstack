-- Reverses 'outbox_payload_bound', restoring the stored-size bound.
ALTER TABLE "outbox_events" DROP CONSTRAINT "outbox_events_payload_size";

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_payload_size"
  CHECK (pg_column_size("payload") <= 65536);
