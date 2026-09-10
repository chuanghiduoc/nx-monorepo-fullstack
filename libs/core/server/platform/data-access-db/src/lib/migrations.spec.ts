import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MIGRATIONS_DIR,
  listMigrations,
  stageHistory,
} from '../../tools/migration-history.js';

const SUITE_TIMEOUT_MS = 300_000;
const SHADOW_DATABASE = 'shadow';
const libraryRoot = join(import.meta.dirname, '..', '..');

/**
 * Exit codes of `prisma migrate diff --exit-code` (documented):
 * 0 = no difference, 1 = error, 2 = differences found.
 */
const DIFF_EMPTY = 0;
const DIFF_FOUND = 2;

/**
 * The one thing the database has that `schema.prisma` cannot say.
 *
 * Prisma has no way to declare an HNSW index — there is no `type: Hnsw`, and
 * the operator class is pgvector's — so `migrate diff` reports it as something
 * to drop, forever. The assertion below is exact rather than relaxed: any
 * *other* difference is still a failure, which is what the drift check is for.
 *
 * A model edited without a migration still fails here. Only this one index is
 * forgiven, and only in this exact form.
 */
const UNEXPRESSIBLE_IN_THE_SCHEMA = [
  '-- DropIndex',
  'DROP INDEX "ai_chunks_embedding_hnsw";',
].join('\n');

/**
 * The migration history is only trustworthy if it can be replayed from
 * nothing, matches the schema when it has been, and can be walked back one
 * step at a time. Each of those is a command against a real PostgreSQL, not a
 * review comment.
 */
describe('migration history', () => {
  let database: TestPostgres;
  let env: NodeJS.ProcessEnv;
  let staging: string;

  beforeAll(async () => {
    // The harness has already run migrate deploy; the suite walks the
    // history back from that state and forward again.
    database = await startPostgres();

    // `migrate diff --from-migrations` replays the history into a shadow
    // database; a second database in the same container is enough.
    // The owner connection, not app_user: this suite applies and reverses DDL,
    // and the application role deliberately cannot do that. Using app_user
    // here would report a permissions error as a broken down script.
    env = {
      ...process.env,
      DATABASE_URL: database.migrationUri,
      SHADOW_DATABASE_URL: await database.createDatabase(SHADOW_DATABASE),
    };
    // The configuration prefers this over DATABASE_URL when it is set, and a
    // developer's own file sets it to their local database — which the task
    // runner loads into every task. Left in place, this suite would replay
    // migration history against that database instead of the container.
    delete env['MIGRATION_DATABASE_URL'];
    staging = mkdtempSync(join(tmpdir(), 'migration-history-'));
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    if (staging) rmSync(staging, { recursive: true, force: true });
    await database?.stop();
  });

  function prisma(args: string[]): { status: number; stdout: string } {
    try {
      const stdout = execFileSync('pnpm', ['exec', 'prisma', ...args], {
        cwd: libraryRoot,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
      return { status: 0, stdout };
    } catch (error) {
      const failure = error as {
        status?: number;
        stdout?: string;
        stderr?: string;
      };
      // `--exit-code` uses 2 to mean "differences found"; that is a result,
      // not a failure.
      if (failure.status === DIFF_FOUND) {
        return { status: DIFF_FOUND, stdout: failure.stdout ?? '' };
      }
      throw new Error(
        `prisma ${args.join(' ')} failed:\n${failure.stderr ?? ''}${failure.stdout ?? ''}`,
      );
    }
  }

  function databaseMatchesHistory(names: string[]): number {
    const history = stageHistory(
      join(staging, `history-${names.length}`),
      names,
    );
    return prisma([
      'migrate',
      'diff',
      '--from-config-datasource',
      ...(names.length === 0 ? ['--to-empty'] : ['--to-migrations', history]),
      '--exit-code',
    ]).status;
  }

  it('every migration ships a down script', () => {
    for (const name of listMigrations()) {
      expect(
        existsSync(join(MIGRATIONS_DIR, name, 'down.sql')),
        `${name}/down.sql`,
      ).toBe(true);
    }
  });

  it(
    'applies from nothing, matches the schema, walks back one step at a time, and re-applies',
    () => {
      const migrations = listMigrations();

      prisma(['migrate', 'deploy']);

      // Drift check: the migrated database is what schema.prisma describes,
      // apart from the one index the schema language cannot express. A model
      // edit without a migration fails here.
      const drift = prisma([
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--script',
      ]).stdout;

      expect(withoutPreamble(drift)).toBe(UNEXPRESSIBLE_IN_THE_SCHEMA);

      const fullSchema = prisma([
        'migrate',
        'diff',
        '--from-empty',
        '--to-config-datasource',
        '--script',
      ]).stdout;

      // Walk back newest first. After rolling back migration N the database
      // must equal "history up to N-1" — the strongest statement a down script
      // can make, and the one a diff can verify.
      for (let index = migrations.length - 1; index >= 0; index -= 1) {
        const name = migrations[index];
        prisma([
          'db',
          'execute',
          '--file',
          join(MIGRATIONS_DIR, name, 'down.sql'),
        ]);
        // Prisma has no command that forgets a *successfully* applied
        // migration — `migrate resolve --rolled-back` is for ones that failed
        // — so the history row is removed directly.
        prisma(['db', 'execute', '--file', writeForget(name)]);

        expect(
          databaseMatchesHistory(migrations.slice(0, index)),
          `after rolling back ${name}`,
        ).toBe(DIFF_EMPTY);
      }

      // And forward again: the down scripts left nothing behind that would make
      // the up scripts fail or produce a different schema.
      prisma(['migrate', 'deploy']);
      expect(
        prisma([
          'migrate',
          'diff',
          '--from-empty',
          '--to-config-datasource',
          '--script',
        ]).stdout,
      ).toBe(fullSchema);
    },
    SUITE_TIMEOUT_MS,
  );

  /**
   * The diff script without the config line Prisma prints before it.
   *
   * `prisma.config.ts` makes every command announce that it loaded, on stdout,
   * so the script is never the first thing in the output.
   */
  function withoutPreamble(output: string): string {
    return output
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('Loaded Prisma config'))
      .join('\n')
      .trim();
  }

  function writeForget(name: string): string {
    const file = join(staging, `forget-${name}.sql`);
    const sql = `DELETE FROM "_prisma_migrations" WHERE migration_name = '${name}';\n`;
    writeFileSync(file, sql);
    return file;
  }

  it('the checked-in down scripts were reviewed, not just generated', () => {
    // The generator leaves a header saying the script needs review. A rename
    // migration whose down script still contains DROP COLUMN would lose data.
    const renameMigration =
      '20260902120000_snake_case_columns_and_ms_precision';
    const down = readFileSync(
      join(MIGRATIONS_DIR, renameMigration, 'down.sql'),
      'utf8',
    );

    expect(down).not.toMatch(/DROP COLUMN/);
    expect(down).toMatch(/RENAME COLUMN/);
  });
});
