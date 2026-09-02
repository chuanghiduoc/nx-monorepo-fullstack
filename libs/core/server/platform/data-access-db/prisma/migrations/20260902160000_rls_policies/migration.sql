-- Row-level security for the tenant-scoped tables.
--
-- Written by hand with --create-only: Prisma's schema cannot express a policy,
-- and this is the layer that still protects tenants when application code is
-- wrong. Everything above it — the resolved request context, the transaction
-- that sets the GUCs, the guard extension — helps a developer write correct
-- code. This is what holds when they did not.
--
-- ENABLE turns policies on for everyone except the table owner. FORCE removes
-- that exception, so the owner is bound too. Superusers and roles with
-- BYPASSRLS are never bound by either, which is why the application connects
-- as app_user and refuses to boot as anything else.
--
-- current_setting(..., true) returns NULL rather than raising when the setting
-- was never set, and NULLIF turns the empty string into NULL as well. Without
-- both, a request with no tenant context would fail with a cast error instead
-- of simply seeing nothing.

-- ---------------------------------------------------------------------------
-- notes — TENANT_OWNED: one organization owns every row.
-- ---------------------------------------------------------------------------
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "notes"
  USING (
    "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  -- WITH CHECK governs writes. Without it a request could plant a row in
  -- another organization: the row would be invisible to its author afterwards,
  -- and perfectly visible to the tenant it was planted in.
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------------
-- bookmarks — TENANT_OPTIONAL: an organization's row, or a person's own.
--
-- The second branch names the user. A policy of "org_id IS NULL OR org_id =
-- current" would show every personal row to every organization, which is the
-- exact failure this shape exists to avoid.
-- ---------------------------------------------------------------------------
ALTER TABLE "bookmarks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bookmarks" FORCE ROW LEVEL SECURITY;

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
