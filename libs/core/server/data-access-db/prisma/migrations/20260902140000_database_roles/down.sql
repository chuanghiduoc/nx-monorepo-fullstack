-- Down migration for 20260902140000_database_roles.
--
-- Roles are cluster-wide and other databases in the same cluster may still
-- grant to them, so this revokes rights *in this database* and stops there.
-- DROP ROLE would fail with "role cannot be dropped because some objects
-- depend on it" the moment the shadow database holds a grant — and dropping a
-- role another database still uses would be worse than leaving it.

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM app_user, worker_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT ON TABLES FROM cross_tenant_admin_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM app_user, worker_user;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_user, worker_user;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_user, worker_user, cross_tenant_admin_role;
REVOKE USAGE ON SCHEMA public FROM app_user, worker_user, erasure_role, cross_tenant_admin_role;
