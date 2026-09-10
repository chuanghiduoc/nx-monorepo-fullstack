-- CreateTable
CREATE TABLE "feature_flags" (
    "key" VARCHAR(128) NOT NULL,
    "value" JSONB NOT NULL,
    "description" VARCHAR(512) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "flag_overrides" (
    "org_id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "value" JSONB NOT NULL,
    "reason" VARCHAR(512) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flag_overrides_pkey" PRIMARY KEY ("org_id","key")
);

-- Below is not expressible in the schema language.

-- ---------------------------------------------------------------------------
-- Row-level security.
--
-- feature_flags is GLOBAL: the same row answers for every organization, so
-- there is nothing to isolate and no policy to write. flag_overrides is
-- TENANT_OWNED and gets the single-branch template, plus the same second
-- policy the quota tables use — a background process that has to read across
-- tenants gets a policy naming its role, rather than the table having none.
-- ---------------------------------------------------------------------------
ALTER TABLE "flag_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "flag_overrides" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "flag_overrides"
  USING (
    "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- The worker evaluates flags for the tenant a job belongs to without opening a
-- tenant transaction — an audit consumer, for instance, is deliberately
-- system-scoped because the event's tenant is data rather than a scope.
CREATE POLICY reader ON "flag_overrides"
  FOR SELECT TO worker_user USING (true);

-- ---------------------------------------------------------------------------
-- Grants.
--
-- Both roles read and neither writes. A flag is changed by a migration or by
-- an operator with the owner connection, because the ability to rewrite a flag
-- from the application is the ability to rewrite it through an injection — and
-- a flag is precisely the switch somebody would most want to flip.
--
-- When an administrative route to edit flags exists, it brings its own grant
-- and its own authorization, and that is the right moment to decide who may.
-- ---------------------------------------------------------------------------
REVOKE ALL ON "feature_flags", "flag_overrides"
  FROM app_user, worker_user, cross_tenant_admin_role;

GRANT SELECT ON "feature_flags" TO app_user, worker_user, cross_tenant_admin_role;
GRANT SELECT ON "flag_overrides" TO app_user, worker_user;

-- cross_tenant_admin_role reads the global defaults, which are not a tenant's
-- data, and not the overrides, which are.
