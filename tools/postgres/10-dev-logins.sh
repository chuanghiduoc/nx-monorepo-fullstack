#!/bin/sh
# Development logins for the roles created by the database_roles migration.
#
# The migration creates them NOLOGIN and without a password on purpose: a
# credential committed to git is a credential leaked. This script runs once, on
# an empty data directory, and is the development-only counterpart of the step
# an operator performs once in production: granting each role a login with a
# password from the deployment's secret store.
#
# It must tolerate running before the migration has ever been applied, so it
# creates the role if needed and then grants the login.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'worker_user') THEN
    CREATE ROLE worker_user;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erasure_role') THEN
    CREATE ROLE erasure_role;
  END IF;
END $$;

ALTER ROLE app_user LOGIN PASSWORD 'app_user';
ALTER ROLE worker_user LOGIN PASSWORD 'worker_user';
-- The erasure job's own login. It is the only role that may delete a person or
-- edit an audit record, so it is deliberately not one of the two the
-- applications connect as.
ALTER ROLE erasure_role LOGIN PASSWORD 'erasure_role';
SQL
