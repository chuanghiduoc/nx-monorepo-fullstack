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

      // Drift check: the migrated database is exactly what schema.prisma
      // describes. A model edit without a migration fails here.
      expect(
        prisma([
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema',
          'prisma/schema.prisma',
          '--exit-code',
        ]).status,
      ).toBe(DIFF_EMPTY);

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
        // Prisma has no command that forgets a *successfully* applied migration
        // (`migrate resolve --rolled-back` is for failed ones), so the history
        // row is removed directly. See docs/contracts/migrations.md.
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
