-- The five roles from spec §6.17. Written by hand with --create-only: Prisma's
-- schema cannot express roles, grants or RLS, and this is the only place the
-- database's own invariants can live.
--
-- Roles are CLUSTER-wide while migration history is per-database. This
-- migration replays into the shadow database in the same cluster, so every
-- CREATE ROLE must tolerate the role already existing.
--
-- No passwords here: a secret in git is a secret leaked. The roles are NOLOGIN;
-- docker-compose grants the dev login, and production does it out of band.

DO $$
BEGIN
  -- core-api: CRUD on business tables through RLS, minimum rights on SYSTEM tables.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;

  -- core-worker: as app_user, plus claiming the outbox and running sweepers.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'worker_user') THEN
    CREATE ROLE worker_user NOLOGIN;
  END IF;

  -- The erasure job: column-level UPDATE on audit rows, deletes by procedure.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erasure_role') THEN
    CREATE ROLE erasure_role NOLOGIN;
  END IF;

  -- The migration entrypoint: DDL and BYPASSRLS, never used in a request path.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'migration_role') THEN
    CREATE ROLE migration_role NOLOGIN BYPASSRLS;
  END IF;

  -- Internal cross-tenant admin reads: a separate connection string, audited
  -- on every use. Deliberately not the same thing as "system context".
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cross_tenant_admin_role') THEN
    CREATE ROLE cross_tenant_admin_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

-- Schema access. USAGE only: app_user must never create objects.
GRANT USAGE ON SCHEMA public TO app_user, worker_user, erasure_role, cross_tenant_admin_role;

-- Existing tables. Future tables are covered by the default privileges below,
-- but only for objects created by the role that owns this migration — which is
-- why a migration that creates a table as a different role must grant it too.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, worker_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cross_tenant_admin_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user, worker_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, worker_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO cross_tenant_admin_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user, worker_user;
