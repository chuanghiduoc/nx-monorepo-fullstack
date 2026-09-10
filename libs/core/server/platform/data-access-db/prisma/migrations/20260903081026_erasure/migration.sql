-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3);

-- Below is not expressible in the schema language.

-- The sweep's predicate: rows past their grace window. Partial, because the
-- overwhelming majority of rows have a NULL here and an index over them would
-- be a table scan wearing an index's name.
CREATE INDEX "user_deleted_at_idx" ON "user" ("deleted_at")
  WHERE "deleted_at" IS NOT NULL;
CREATE INDEX "organization_deleted_at_idx" ON "organization" ("deleted_at")
  WHERE "deleted_at" IS NOT NULL;

-- Anonymising an audit record: the one thing the trail allows to be edited.
CREATE INDEX "audit_records_actor_id_idx" ON "audit_records" ("actor_id")
  WHERE "actor_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- erasure_role: the only role that may edit an audit record, and the only one
-- that may delete a person.
--
-- **One role for both halves, and that is the correction this migration
-- exists to make.** The obvious split — the worker deletes the user,
-- `erasure_role` anonymises the trail — cannot be one transaction, because two
-- roles are two connections. A crash between them leaves a deleted user whose
-- audit rows still name them, which is the exact state the feature exists to
-- prevent, reachable by an ordinary restart. Worse, it is unrecoverable: once
-- the user row is gone there is no list of ids left to anonymise from.
--
-- So this role does both, in one transaction, and `worker_user` does neither.
-- That is the property worth having: no consumer of the outbox can edit the
-- trail, because none of them holds the grant.
-- ---------------------------------------------------------------------------
GRANT SELECT ON "user", "organization" TO erasure_role;
GRANT DELETE ON "user", "organization" TO erasure_role;

-- Column-level, and the columns are the ones this schema actually has. The
-- roles migration promised "(ip, user_agent, diff)" from a design whose audit
-- table had those columns; ours holds `actor_id` and a `detail` jsonb.
--
-- No UPDATE on anything else, no DELETE at all: an erasure removes the person
-- from the record, never the record. A trail with holes in it is not a trail,
-- and a trail naming somebody who exercised their right to be forgotten is not
-- lawful. Keeping the row and removing the person satisfies both.
GRANT SELECT ON "audit_records" TO erasure_role;
GRANT UPDATE ("actor_id", "detail") ON "audit_records" TO erasure_role;

-- The identity tables cascade from `user`, so the role needs nothing on them:
-- `session`, `account`, `member`, `invitation` and `twofactor` are all
-- `ON DELETE CASCADE`, and a cascade runs with the rights of the deleting
-- statement rather than needing its own grant.
