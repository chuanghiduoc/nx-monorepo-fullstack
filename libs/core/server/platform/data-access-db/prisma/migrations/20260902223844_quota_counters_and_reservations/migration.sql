-- CreateTable
CREATE TABLE "org_quota_counters" (
    "org_id" UUID NOT NULL,
    "entitlement" VARCHAR(64) NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "used" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_quota_counters_pkey" PRIMARY KEY ("org_id","entitlement","window_start")
);

-- CreateTable
CREATE TABLE "quota_reservations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "entitlement" VARCHAR(64) NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "amount" BIGINT NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'RESERVED',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quota_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quota_reservations_state_expires_at_idx" ON "quota_reservations"("state", "expires_at");

-- Below is not expressible in the schema language.

-- The invariant that is always true. The ceiling is deliberately NOT here:
-- measured on PostgreSQL 18, a CHECK of `used <= limit` makes lowering a
-- plan's limit below current usage fail with a constraint violation, so
-- downgrading becomes impossible for exactly the tenants who do it. The
-- ceiling is enforced by the consume statement, on every write, against the
-- limit in force at that moment.
--
-- This one fires only for a bug — a refund of units that were never taken —
-- and it fires loudly, which is what a bug deserves.
ALTER TABLE "org_quota_counters"
  ADD CONSTRAINT "org_quota_counters_used_nonneg" CHECK ("used" >= 0);

-- A reservation holds a positive number of units. Zero would be a reservation
-- that reserves nothing and still has to be committed or released.
ALTER TABLE "quota_reservations"
  ADD CONSTRAINT "quota_reservations_amount_positive" CHECK ("amount" > 0);

-- The state machine, in the database rather than only in the repository.
ALTER TABLE "quota_reservations"
  ADD CONSTRAINT "quota_reservations_state"
  CHECK ("state" IN ('RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED'));

-- An open reservation has not closed, and a closed one has. Without this a
-- release that forgot the stamp would look open forever to the sweep, which
-- would then expire an already-refunded reservation and refund it twice.
ALTER TABLE "quota_reservations"
  ADD CONSTRAINT "quota_reservations_closed_when_settled"
  CHECK (("state" = 'RESERVED') = ("closed_at" IS NULL));

-- ---------------------------------------------------------------------------
-- Row-level security.
--
-- Both tables are TENANT_OWNED, which is a correction rather than a
-- preference. The obvious reading is SYSTEM — the sweeper that returns expired
-- units has to see every tenant and worker_user has no BYPASSRLS — but SYSTEM
-- means no policy, and a table with no policy is not protected by row-level
-- security at all. app_user needs INSERT, SELECT and UPDATE on the counter to
-- consume (SELECT because an ON CONFLICT target is an inference specification,
-- which reads the table), and on a SYSTEM table those rights reach every
-- tenant's row from the process that faces the internet.
--
-- Policies are OR-ed and a policy can name a role, so the sweeper gets its own
-- rather than the table getting none. Measured on PostgreSQL 18 with FORCE on:
-- app_user with tenant A's context sees one row and updates zero of tenant
-- B's; app_user with no context set sees nothing; worker_user with no context
-- at all sees every tenant and updates them.
-- ---------------------------------------------------------------------------
ALTER TABLE "org_quota_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_quota_counters" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "org_quota_counters"
  USING (
    "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- The sweeper's view, and only the sweeper's. It runs in a system transaction
-- with no tenant GUC set, returning units from reservations that expired.
CREATE POLICY sweeper ON "org_quota_counters"
  FOR ALL TO worker_user USING (true) WITH CHECK (true);

ALTER TABLE "quota_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quota_reservations" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "quota_reservations"
  USING (
    "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY sweeper ON "quota_reservations"
  FOR ALL TO worker_user USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Grants. The policy above decides which rows; these decide which verbs.
-- ---------------------------------------------------------------------------
REVOKE ALL ON "org_quota_counters", "quota_reservations"
  FROM app_user, worker_user, cross_tenant_admin_role;

-- Consuming is one statement that may insert or may update, and needs SELECT
-- for the ON CONFLICT target either way. No DELETE: nothing in a request
-- removes a counter, and the right to delete one is the right to reset a
-- quota to zero.
GRANT INSERT, SELECT, UPDATE ON "org_quota_counters" TO app_user;

-- Reserving inserts; committing and releasing are state transitions, which is
-- why there is no DELETE here either — a settled reservation is the record
-- that the units came back.
GRANT INSERT, SELECT, UPDATE ON "quota_reservations" TO app_user;

-- The sweep reads overdue reservations, marks them EXPIRED and returns their
-- units to the counter. It never creates either.
GRANT SELECT, UPDATE ON "quota_reservations" TO worker_user;
GRANT SELECT, UPDATE ON "org_quota_counters" TO worker_user;

-- cross_tenant_admin_role gets nothing. Support reading a tenant's usage is a
-- reasonable thing to want and an unreasonable thing to inherit from a default
-- privilege; it is granted when a route needs it and somebody has decided
-- which tenants it may read.
