-- Reverses 'outbox_events'.
--
-- Dropping the tables takes the grants and the check constraint with them, so
-- there is nothing to revoke first. Undelivered events are lost, which is what
-- rolling back an outbox means: run this only when the relay is stopped and
-- the table is empty, or accept that whatever was pending never happens.
DROP TABLE IF EXISTS "processed_events";
DROP TABLE IF EXISTS "outbox_events";
