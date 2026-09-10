-- CreateTable
CREATE TABLE "outbox_events" (
    "event_id" UUID NOT NULL DEFAULT uuidv7(),
    "aggregate_type" VARCHAR(64) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER,
    "event_type" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "tenant_id" UUID,
    "actor_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enqueued_at" TIMESTAMPTZ(3),
    "locked_at" TIMESTAMPTZ(3),
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "consumer" VARCHAR(64) NOT NULL,
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer","event_id")
);

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_event_id_idx" ON "outbox_events"("status", "available_at", "event_id");

-- CreateIndex
CREATE INDEX "outbox_events_status_locked_at_event_id_idx" ON "outbox_events"("status", "locked_at", "event_id");

-- CreateIndex
CREATE INDEX "outbox_events_status_enqueued_at_idx" ON "outbox_events"("status", "enqueued_at");

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- The two statements above are Prisma's. Everything below is not expressible in
-- the schema language, and each line is load-bearing.

-- A payload is metadata, not content, so this bound should never be reached.
-- It is a backstop for the day somebody decides an event should "just carry
-- the record" — pg_column_size measures the value before TOAST, so a large
-- payload fails here rather than being silently compressed into acceptance.
-- Prisma does not model check constraints, so this causes no schema drift.
ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_payload_size"
  CHECK (pg_column_size("payload") <= 65536);

-- Both tables inherit SELECT, INSERT, UPDATE and DELETE for app_user and
-- worker_user from the ALTER DEFAULT PRIVILEGES in the roles migration, and
-- SELECT for cross_tenant_admin_role. Row-level security does nothing here:
-- these tables carry no policy, so an app_user session inside a tenant
-- transaction reads and writes them freely.
--
-- Left alone that means an injection through the API reads every tenant's
-- payloads, deletes an event before the relay sees it, or marks one ENQUEUED
-- to swallow it. So the inherited grants come off and the narrow ones go on.
REVOKE ALL ON "outbox_events", "processed_events"
  FROM app_user, worker_user, cross_tenant_admin_role;

-- The API publishes and does nothing else with the table: it cannot read back
-- what it wrote, which is why append() must not use a statement with RETURNING.
GRANT INSERT ON "outbox_events" TO app_user;

-- The relay claims, marks, fails, kills and sweeps. It never publishes —
-- nothing on the worker side does today, and a producer that appears later
-- should have to ask for the grant rather than find it lying there.
GRANT SELECT, UPDATE, DELETE ON "outbox_events" TO worker_user;

-- The consumer writes its own dedup row and the relay's sweep removes old
-- ones. app_user gets nothing: processed_events *is* the exactly-once
-- guarantee, so the ability to plant a row here is the ability to make a
-- consumer skip a real event.
GRANT INSERT, SELECT, DELETE ON "processed_events" TO worker_user;
