# Contract: integration testing

There is exactly one way to get a database in a test:
`startPostgres()` from `@workspace/core-server-testing`.

```ts
import { POSTGRES_START_TIMEOUT_MS, startPostgres, type TestPostgres } from '@workspace/core-server-testing';

let database: TestPostgres;

beforeAll(async () => {
  database = await startPostgres(); // real PostgreSQL 18, fully migrated
  prisma = new PrismaService();      // reads DATABASE_URL, which the harness set
}, POSTGRES_START_TIMEOUT_MS);

afterAll(() => database.stop());
```

## What the harness guarantees

- **A real PostgreSQL 18**, the image docker-compose runs, via Testcontainers.
  Conventions such as `uuidv7()` defaults and `TIMESTAMPTZ(3)` are what the
  database does, so a mock would test nothing.
- **A connection that row-level security can bind.** `connectionUri` is
  `app_user`, never the container's superuser: `FORCE ROW LEVEL SECURITY`
  binds table owners and has never bound superusers or `BYPASSRLS` roles, so a
  suite running as one would report isolation it does not have. Measured
  before the change: a `FORCE` policy admitting one tenant returned both rows
  (ADR-0003). `migrationUri` is the owner connection, for migrations and for
  setup a policy would otherwise block.
- **Every migration applied** with `prisma migrate deploy` — the command a
  deployment runs. A test never sees a schema that differs from production's,
  and a migration that fails to apply fails here first.
- **Parallel-safe.** Each suite gets its own container. The CLI is invoked
  directly rather than through its Nx target because Vitest runs files in
  parallel workers and concurrent `nx run` processes contend for the
  workspace lock (observed: two of three suites failing at random).
- **`createDatabase(name)`** for a sibling database in the same container —
  the migration suite uses it as Prisma's shadow database.

Every suite that claims to prove tenant isolation opens with
`rls-harness.spec.ts`: `current_user` is neither a superuser nor a `BYPASSRLS`
role, `SET ROLE postgres` fails, and a `FORCE` policy actually hides a row.
Without that, a green tenancy gate means nothing.

## Factories

`@faker-js/faker` + `fishery`, seeded once so a failing test reproduces with
the same data. Factories build *inputs* (the create request), not rows: the
database owns ids and timestamps, and a factory that invented them would hide
exactly the conventions the tests exist to prove.

```ts
await prisma.demoItem.createMany({ data: demoItemFactory.buildList(25) });
```

## Boundaries

`core-server-testing` is `type:util`, so both the data-access layer and the
apps may import it, and it imports neither — it knows the data-access library
only as a directory containing migrations. That is what keeps the dependency
graph acyclic while the data-access library's own tests use the harness.

## Used by

- `libs/core/server/platform/data-access-db/src/lib/{prisma.service,idempotency.store,migrations}.spec.ts`
- `apps/core/api/src/app/demo-items/demo-items.service.spec.ts`
