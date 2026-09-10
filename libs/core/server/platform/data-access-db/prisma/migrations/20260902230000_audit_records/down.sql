-- Reverses 'audit_records'.
--
-- Dropping the table takes its grants with it. The UPDATE grant on
-- processed_events is separate and is revoked explicitly: leaving it would
-- leave a privilege behind whose reason had gone.
REVOKE UPDATE ("processed_at") ON "processed_events" FROM worker_user;
DROP TABLE IF EXISTS "audit_records";
