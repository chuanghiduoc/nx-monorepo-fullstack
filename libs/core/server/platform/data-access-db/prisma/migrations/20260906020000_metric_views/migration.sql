-- Aggregates the API may read, and nothing else.
--
-- The scrape needs two numbers that live in tables the application role
-- deliberately cannot read: `outbox_events` belongs to the worker, and
-- `webhook_deliveries` is behind row-level security that a system transaction
-- with no tenant reads as empty. Measured, both ways: the first answered
-- `permission denied for table outbox_events`, and the second answered zero —
-- which is worse, because a gauge that reads zero looks exactly like a gauge
-- that has nothing to report.
--
-- A view is the smallest thing that fixes both. It is owned by the migration
-- role, and PostgreSQL evaluates a view's underlying access as its owner unless
-- `security_invoker` says otherwise — so the aggregate is computed with the
-- owner's rights and the API receives counts. There is no row, no payload, no
-- organization id and no way to ask for one: the view has no WHERE a caller can
-- influence.
--
-- Granting `SELECT` on the tables themselves would have been one line and would
-- have handed the API every tenant's event payloads.

CREATE VIEW "outbox_state_counts" AS
  SELECT status, COUNT(*)::bigint AS count
    FROM "outbox_events"
   GROUP BY status;

-- The window is in the view rather than in a parameter, because a view cannot
-- take one — and because "how many failed in the last hour" is the question
-- somebody asks at three in the morning. "How many have ever failed" is a
-- number that only goes up and answers nothing.
CREATE VIEW "webhook_delivery_outcomes" AS
  SELECT CASE
           WHEN status IS NULL THEN 'unreachable'
           WHEN status BETWEEN 200 AND 299 THEN 'delivered'
           ELSE 'refused'
         END AS outcome,
         COUNT(*)::bigint AS count
    FROM "webhook_deliveries"
   WHERE created_at > now() - interval '1 hour'
   GROUP BY 1;

REVOKE ALL ON "outbox_state_counts", "webhook_delivery_outcomes"
  FROM app_user, worker_user, cross_tenant_admin_role;

GRANT SELECT ON "outbox_state_counts" TO app_user;
GRANT SELECT ON "webhook_delivery_outcomes" TO app_user;
