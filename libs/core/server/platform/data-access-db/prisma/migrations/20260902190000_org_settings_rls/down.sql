-- Down migration for 20260902190000_org_settings_rls.

DROP POLICY tenant_isolation ON "org_settings";
ALTER TABLE "org_settings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "org_settings" DISABLE ROW LEVEL SECURITY;
