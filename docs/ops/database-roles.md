# Database roles

Five roles, created by the `database_roles` migration and each with explicit
grants (spec §6.17). They are cluster-wide objects; the migration creates them
idempotently because the same history replays into the shadow database.

| Role | Used by | Rights |
|---|---|---|
| `app_user` | core-api | CRUD on business tables **through RLS**; minimum rights on SYSTEM tables |
| `worker_user` | core-worker (Phase 4) | as `app_user`, plus claiming the outbox and running sweepers |
| `erasure_role` | the erasure job (Phase 4) | column-level UPDATE on audit rows; deletes by procedure |
| `migration_role` | the migration entrypoint | DDL and `BYPASSRLS` |
| `cross_tenant_admin_role` | internal admin reads | `BYPASSRLS` read on a separate connection string, audited on every use |

## Why the application does not connect as the owner

`FORCE ROW LEVEL SECURITY` binds table owners. It has never bound superusers or
roles with `BYPASSRLS`. An application connected as the owner would see every
tenant's rows with every policy in place and no error anywhere — and so would
every test that claims to prove isolation. Measured before the split: a `FORCE`
policy admitting one tenant returned both rows (ADR-0003).

So `DATABASE_URL` is `app_user` and `MIGRATION_DATABASE_URL` is the owner. The
application cannot run DDL, which is deliberate: migrations are a deployment
step, never something a booting replica does (spec §6.17).

## Passwords

The migration creates every role `NOLOGIN` and with no password. A credential
in git is a credential leaked, and a migration is the most-copied file in the
repository.

- **Development:** `tools/postgres/10-dev-logins.sh` runs on first container
  start and grants a well-known development password. It runs **only on an
  empty data directory** — a volume from before this change keeps the roles
  without a login, and the API refuses to boot with a message naming
  `docker compose down -v`.
- **Tests:** the harness grants its own login inside the container it created.
- **Production:** run once, with the password from the secret manager:

```sql
ALTER ROLE app_user LOGIN PASSWORD '<from the secret manager>';
ALTER ROLE worker_user LOGIN PASSWORD '<from the secret manager>';
```

Rotation is the same statement with a new value, followed by a rolling restart
of the services holding connections. PostgreSQL does not invalidate existing
sessions on a password change, so the restart is what completes the rotation.

## Checking a deployment

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles
WHERE rolname LIKE '%_user' OR rolname LIKE '%_role';
```

`app_user` and `worker_user` must show `rolsuper = false` and
`rolbypassrls = false`. If either is true, RLS is not protecting anything.
