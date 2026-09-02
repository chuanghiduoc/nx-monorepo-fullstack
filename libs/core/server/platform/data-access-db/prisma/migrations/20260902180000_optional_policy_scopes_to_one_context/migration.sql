-- A tenant-optional row is visible in exactly one context, not two.
--
-- The first version of this policy read:
--
--   org_id = current_org OR (org_id IS NULL AND user_id = current_user)
--
-- Both GUCs are set while a member acts inside an organization, so the second
-- branch also matched and the organization context saw the member's personal
-- rows alongside the organization's own. An isolation test caught it.
--
-- That is wider than intended in a way that matters: anything that reads "all
-- the rows this organization can see" — an export, an audit, a report — would
-- have quietly included private rows belonging to whoever ran it.
--
-- The personal branch now applies only when no organization is active. A
-- member who wants their personal rows leaves the organization context, which
-- is the same act that decides which rows they may write.

DROP POLICY tenant_isolation ON "bookmarks";

CREATE POLICY tenant_isolation ON "bookmarks"
  USING (
    "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR (
      "org_id" IS NULL
      AND NULLIF(current_setting('app.current_org_id', true), '') IS NULL
      AND "user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR (
      "org_id" IS NULL
      AND NULLIF(current_setting('app.current_org_id', true), '') IS NULL
      AND "user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  );
