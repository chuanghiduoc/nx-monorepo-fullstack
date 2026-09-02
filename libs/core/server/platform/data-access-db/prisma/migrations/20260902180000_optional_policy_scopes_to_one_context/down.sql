-- Down migration for 20260902180000_optional_policy_scopes_to_one_context.
--
-- Restores the wider policy, in which an organization context also sees the
-- acting member's personal rows. Reversible, but the wider form is the one the
-- isolation test rejects.

DROP POLICY tenant_isolation ON "bookmarks";

CREATE POLICY tenant_isolation ON "bookmarks"
  USING (
    "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR (
      "org_id" IS NULL
      AND "user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR (
      "org_id" IS NULL
      AND "user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  );
