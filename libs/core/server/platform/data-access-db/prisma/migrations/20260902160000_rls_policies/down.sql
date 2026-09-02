-- Down migration for 20260902160000_rls_policies.
--
-- Order matters: dropping the policy while row-level security is still forced
-- would leave the tables readable by nobody but the owner, which is a worse
-- state than either end of the migration.

DROP POLICY tenant_isolation ON "bookmarks";
ALTER TABLE "bookmarks" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "bookmarks" DISABLE ROW LEVEL SECURITY;

DROP POLICY tenant_isolation ON "notes";
ALTER TABLE "notes" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "notes" DISABLE ROW LEVEL SECURITY;
