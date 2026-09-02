-- org_settings is TENANT_OWNED: the same policy shape as any other table an
-- organization owns. Written separately from the table because Prisma's schema
-- cannot express a policy, and combined into one migration it would be easy to
-- add a table later and forget this half.

ALTER TABLE "org_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_settings" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "org_settings"
  USING (
    "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );
