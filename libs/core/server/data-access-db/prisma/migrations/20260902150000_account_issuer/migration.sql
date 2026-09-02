-- better-auth 1.7 added `account.issuer`. The schema generator (@better-auth/cli
-- 1.4) does not know about it, so it was missing from the generated schema and
-- every sign-up failed with a Prisma validation error naming a column the
-- database had never heard of. auth-schema.spec.ts now compares the schema
-- against the installed library so the next gap is a test failure.
--
-- Written with --create-only: the generated version adds a NOT NULL column with
-- no default, which cannot apply to a table that already has rows. Expand,
-- backfill, then contract.

-- 1. expand
ALTER TABLE "account" ADD COLUMN "issuer" TEXT;

-- 2. backfill. better-auth composes the issuer as "<kind>:<providerId>", and
--    every account that exists before this migration is a local credential or
--    an OAuth account keyed by its provider.
UPDATE "account"
SET "issuer" = CASE
  WHEN "provider_id" = 'credential' THEN 'local:credential'
  ELSE 'social:' || "provider_id"
END
WHERE "issuer" IS NULL;

-- 3. contract
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;

CREATE UNIQUE INDEX "account_issuer_account_id_key" ON "account"("issuer", "account_id");
