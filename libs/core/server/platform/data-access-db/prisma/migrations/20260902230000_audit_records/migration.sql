-- CreateTable
CREATE TABLE "audit_records" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "aggregate_type" VARCHAR(64) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER,
    "tenant_id" UUID,
    "actor_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail" JSONB NOT NULL,

    CONSTRAINT "audit_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_records_event_id_key" ON "audit_records"("event_id");

-- Below is not expressible in the schema language.

-- Both tables inherit SELECT, INSERT, UPDATE and DELETE for app_user and
-- worker_user from the ALTER DEFAULT PRIVILEGES in the roles migration, and
-- SELECT for cross_tenant_admin_role. Row-level security does nothing here:
-- a SYSTEM table carries no policy, so an app_user session inside a tenant
-- transaction would read and write it freely.
REVOKE ALL ON "audit_records"
  FROM app_user, worker_user, cross_tenant_admin_role;

-- app_user gets nothing at all. No path exists where the API writes an audit
-- record — every one comes from an event — and a grant kept "for later" is a
-- grant nobody reviews when later arrives.
--
-- cross_tenant_admin_role gets nothing either, and that is the one that will
-- look wrong. A support role reading the trail is a reasonable thing to want;
-- it is not reasonable for it to happen because nobody revoked a default
-- privilege. It is granted when there is a route that uses it and a decision
-- about which tenants it may read.
--
-- worker_user needs SELECT as well as INSERT, and this is not headroom:
-- measured on PostgreSQL 18, `INSERT ... ON CONFLICT (event_id) DO NOTHING`
-- fails with `permission denied` without it, because a conflict target is an
-- inference specification that reads the table. Removing SELECT as unused
-- would break every audit insert, inside the consumer's transaction, only
-- where the grants are real, and never in a test that runs as the owner.
GRANT INSERT, SELECT ON "audit_records" TO worker_user;

-- The relay sweeps processed_events on every replica, not from a single
-- scheduled job, so its delete needs FOR UPDATE SKIP LOCKED to take disjoint
-- rows — and locking a row for update needs UPDATE, which DELETE does not
-- imply. Measured: three concurrent sweepers without it removed exactly what
-- one removes, because they contend for the same rows and the losers see an
-- empty batch and stop.
--
-- Column-level, and that is the whole point rather than tidiness. Measured on
-- PostgreSQL 18: `GRANT UPDATE (processed_at)` is enough for the lock hint,
-- while a table-level grant would also allow `SET event_id` — which forges a
-- dedup row for an event nobody has processed. The consumer would then find a
-- claim, do nothing, and the relay would mark the event delivered: it vanishes
-- from the audit trail, silently. DELETE fails in the opposite direction, and
-- loudly: removing a dedup row causes reprocessing, which the unique index on
-- audit_records.event_id catches and logs. So "it already has DELETE, so
-- UPDATE adds nothing" is not true — the two point opposite ways.
GRANT UPDATE ("processed_at") ON "processed_events" TO worker_user;

-- The roles migration's comment promises erasure_role "column-level UPDATE on
-- audit rows". It holds no default privilege, so it gets nothing here and the
-- promise is not kept yet. Erasure decides which columns it touches, and it
-- grants itself what it needs when it does.
