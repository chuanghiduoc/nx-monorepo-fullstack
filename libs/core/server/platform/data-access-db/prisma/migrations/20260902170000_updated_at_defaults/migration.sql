-- `@updatedAt` is a Prisma behaviour, not a database constraint: the client
-- writes the value on update and leaves the column NOT NULL with no default.
-- Every insert that does not go through Prisma then fails — a SQL fixture, a
-- backfill inside a migration, or a service written in another language, which
-- this workspace is explicitly built to host.
--
-- A default costs nothing and makes the column correct for any writer. Prisma
-- still sets the value itself on update, so behaviour through the client is
-- unchanged.

ALTER TABLE "notes" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "bookmarks" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "demo_items" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "user" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "session" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "account" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "verification" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
