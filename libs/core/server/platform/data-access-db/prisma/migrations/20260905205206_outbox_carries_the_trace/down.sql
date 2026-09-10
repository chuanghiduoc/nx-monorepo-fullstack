-- Reverses the trace column. Nothing reads it that is not also being reverted,
-- and losing it costs a join in a picture rather than any data.
ALTER TABLE "outbox_events" DROP COLUMN IF EXISTS "trace_parent";
