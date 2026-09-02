import { cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const MIGRATIONS_DIR = join(
  import.meta.dirname,
  '..',
  'prisma',
  'migrations',
);
const LOCK_FILE = 'migration_lock.toml';

/** Migration directory names, oldest first — the order Prisma applies them. */
export function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Copies a prefix of the migration history into `dir` so `prisma migrate diff`
 * can be pointed at "the schema as of migration N". The CLI only diffs whole
 * directories; there is no flag for a partial history.
 */
export function stageHistory(dir: string, names: string[]): string {
  cpSync(join(MIGRATIONS_DIR, LOCK_FILE), join(dir, LOCK_FILE));
  for (const migration of names) {
    cpSync(
      join(MIGRATIONS_DIR, migration, 'migration.sql'),
      join(dir, migration, 'migration.sql'),
    );
  }
  return dir;
}
