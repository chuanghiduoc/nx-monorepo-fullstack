-- Down migration for 20260902170000_updated_at_defaults.
--
-- Dropping the default returns the columns to Prisma-only writes. Existing
-- rows keep their values; only future inserts from outside Prisma break, which
-- is the state this migration corrected.

ALTER TABLE "verification" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "account" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "session" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "user" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "demo_items" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "bookmarks" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "notes" ALTER COLUMN "updated_at" DROP DEFAULT;
