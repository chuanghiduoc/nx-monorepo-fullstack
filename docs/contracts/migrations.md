# Contract: database migrations

Prisma Migrate owns the schema. Every change is a migration directory under
`libs/core/server/platform/data-access-db/prisma/migrations/`, and every migration
ships with a `down.sql` beside its `migration.sql`.

## Commands

| Intent | Command |
|---|---|
| Regenerate the client after a schema edit | `pnpm nx run core-server-data-access-db:prisma-generate` (typecheck, build, test and lint depend on it) |
| Create a migration | `pnpm exec prisma migrate dev --name <name>` in the library |
| Create one you need to edit first | `... --create-only`, edit, then `migrate dev` |
| Generate its down script | `pnpm nx run core-server-data-access-db:prisma-down --name=<migration>` |
| Apply in an environment | `pnpm nx run core-server-data-access-db:prisma-migrate-deploy` |
| Check for drift | `pnpm nx test core-server-data-access-db` (`migrations.spec.ts`) |

Both `migrate dev` and `migrate diff --from-migrations` need
`SHADOW_DATABASE_URL`: Prisma replays the history into a throwaway database.
Never point it at a database holding anything; Prisma resets it.

## An applied migration is immutable — comments included

Prisma stores a checksum of every migration it has applied and refuses to
continue when one changes. That includes whitespace inside a comment: a
repository-wide tidy-up once altered `.123456` to `.123456` in an explanatory
line and Prisma answered with "the migration was modified after it was
applied" and a demand to reset the database.

Nothing rewrites a migration that has been applied anywhere. A correction goes
into a new migration; a comment that reads badly stays as it is, or its
explanation moves here.

Recovery, if it happens anyway: restore the file byte for byte from the commit
that introduced it. The checksum matches again and no data is lost. Resetting
the database is the answer only when the file is genuinely gone.

## When the generated SQL is wrong

`prisma migrate dev` cannot tell a rename from a drop-and-add, and the
generated SQL would throw the column's data away. Use `--create-only` and
write `RENAME COLUMN` / `RENAME INDEX` instead. The same applies to anything
Prisma does not model: views, triggers, `CREATE INDEX CONCURRENTLY`, and data
backfills. The migration that renamed columns to snake_case is the reference.

## Down scripts

`prisma-down` follows the vendor's documented workflow: diff the history with
the migration against the history without it, in reverse. The generator writes
a header saying the file needs review, and it means it — a diff renders a
rename as DROP + ADD in *both* directions. Rewrite those by hand; the test
suite checks that the rename migration's down script contains no
`DROP COLUMN`.

Applying one:

```bash
pnpm exec prisma db execute --file prisma/migrations/<name>/down.sql
```

Prisma has no command that forgets a *successfully* applied migration —
`migrate resolve --rolled-back` is for migrations that failed part-way. After
running `down.sql`, remove the history row yourself, otherwise the next deploy
believes the migration is still applied:

```sql
DELETE FROM "_prisma_migrations" WHERE migration_name = '<name>';
```

## What the test proves

`migrations.spec.ts` runs against a fresh PostgreSQL 18 container:

1. `migrate deploy` from nothing succeeds.
2. The migrated database matches `schema.prisma` (`migrate diff --exit-code`).
   A model edit without a migration fails here.
3. Newest first, each `down.sql` is applied and the database is diffed against
   the history up to the previous migration. A down script that leaves
   anything behind, or takes too much away, fails with the migration's name.
4. `migrate deploy` again reproduces byte-for-byte the same schema as step 1.

Commenting out one `DROP TABLE` in a down script was enough to fail step 3.

## Zero-downtime changes

The rules the schema follows so that a deploy never waits on a lock:

- **Expand → backfill → contract.** Add the new column nullable, deploy code
  that writes both, backfill in batches, deploy code that reads the new one,
  then drop the old column in a later migration.
- **`NOT NULL` on a large table** is a full scan. Add a `CHECK (col IS NOT
  NULL) NOT VALID`, `VALIDATE CONSTRAINT` separately, then set `NOT NULL`
  (PostgreSQL uses the validated constraint and skips the scan).
- **Indexes on live tables** use `CREATE INDEX CONCURRENTLY` in their own
  migration, because it cannot run inside a transaction. Prisma wraps each
  migration in one, so the migration needs `-- prisma: no-transaction`
  handling by hand — see `docs/upgrades.md`.
- **Type changes that rewrite the table** (`TIMESTAMPTZ(6)` → `(3)` does; the
  reverse does not) belong in a maintenance window at real volume. The tables
  here were empty of production data when that migration ran.
