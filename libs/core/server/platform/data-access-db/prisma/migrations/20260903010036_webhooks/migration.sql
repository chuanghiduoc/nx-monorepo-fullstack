-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "secret" VARCHAR(128) NOT NULL,
    "event_types" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" INTEGER,
    "error" VARCHAR(512),
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_endpoints_org_id_enabled_idx" ON "webhook_endpoints"("org_id", "enabled");

-- CreateIndex
CREATE INDEX "webhook_deliveries_org_id_endpoint_id_created_at_idx" ON "webhook_deliveries"("org_id", "endpoint_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_created_at_idx" ON "webhook_deliveries"("created_at");

-- Below is not expressible in the schema language.

-- ---------------------------------------------------------------------------
-- Row-level security. Both tables are TENANT_OWNED with the single-branch
-- template, plus the reader policy that names worker_user — the dispatcher
-- runs in a system transaction with no tenant set, and a table with no policy
-- at all would be reachable by app_user across every tenant.
-- ---------------------------------------------------------------------------
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "webhook_endpoints"
  USING ("org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY dispatcher ON "webhook_endpoints"
  FOR SELECT TO worker_user USING (true);

ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "webhook_deliveries"
  USING ("org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY dispatcher ON "webhook_deliveries"
  FOR ALL TO worker_user USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
REVOKE ALL ON "webhook_endpoints", "webhook_deliveries"
  FROM app_user, worker_user, cross_tenant_admin_role;

-- The column list is the whole point, and `secret` is not in it. A route may
-- create an endpoint and return the secret in that one response; no route can
-- ever read it back, because the grant does not permit the column — measured
-- rather than promised, by a test that selects it as app_user and is refused.
--
-- The consequence is that the repository names its columns: Prisma's
-- `findMany` emits SELECT for every column of the model and would fail with
-- `permission denied for column secret`, in production and never in a test
-- that runs as the owner. It is the same trap RETURNING set for the outbox.
GRANT INSERT ON "webhook_endpoints" TO app_user;
GRANT SELECT ("id", "org_id", "url", "event_types", "enabled", "created_at", "updated_at")
  ON "webhook_endpoints" TO app_user;
-- Editing an endpoint: its url, its filter, whether it is on. Not its secret —
-- rotating one is a create-and-delete, which leaves the old deliveries
-- attributable to the key that signed them.
GRANT UPDATE ("url", "event_types", "enabled", "updated_at")
  ON "webhook_endpoints" TO app_user;
GRANT DELETE ON "webhook_endpoints" TO app_user;

-- The dispatcher needs the secret, and that is the only reader that does.
GRANT SELECT ON "webhook_endpoints" TO worker_user;

-- The delivery log is written by the worker and read by the tenant.
GRANT INSERT, SELECT, DELETE ON "webhook_deliveries" TO worker_user;
GRANT SELECT ON "webhook_deliveries" TO app_user;

-- cross_tenant_admin_role gets nothing: an endpoint's URL and a tenant's
-- delivery history are that tenant's data.
