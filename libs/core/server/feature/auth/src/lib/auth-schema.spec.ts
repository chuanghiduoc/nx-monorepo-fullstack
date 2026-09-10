import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getAuthTables } from 'better-auth/db';
import { describe, expect, it } from 'vitest';

import {
  SCHEMA_GENERATION_TUNING,
  authOptionsFor,
} from './auth.options.js';

const SCHEMA_PATH = join(
  import.meta.dirname,
  '../../../..',
  'platform/data-access-db/prisma/schema.prisma',
);

/**
 * The schema better-auth will actually query, compared with the schema Prisma
 * will actually build.
 *
 * `@better-auth/cli` lags the library it generates for — 1.4 against a 1.7
 * core at the time of writing — and the gap is invisible until a request
 * fails. It cost a 500 on every sign-up: better-auth 1.7 added
 * `account.issuer`, the generator knew nothing about it, and Prisma rejected
 * the create with a validation error that named a field the schema had never
 * heard of.
 *
 * So the source of truth is the installed library, read through its own
 * `getAuthTables`, and a mismatch is a failing test rather than a production
 * incident. Add a plugin, run this, and it tells you exactly which columns the
 * migration is missing.
 */
describe('the Prisma schema matches what better-auth expects', () => {
  // The tables come from the plugin list, which no tuning value touches.
  const tables = getAuthTables(
    authOptionsFor(SCHEMA_GENERATION_TUNING) as never,
  ) as Record<
    string,
    { modelName?: string; fields: Record<string, { fieldName?: string }> }
  >;
  const schema = readFileSync(SCHEMA_PATH, 'utf8');

  /** Columns are declared as `@map("snake_case")`, or as the field name itself. */
  const columnsOf = (table: string): Set<string> => {
    const model = schema.match(
      new RegExp(`model \\w+ \\{[^}]*@@map\\("${table}"\\)[^}]*\\}`, 's'),
    );

    if (!model) {
      throw new Error(`No model maps to the table "${table}" in schema.prisma`);
    }

    const columns = new Set<string>();
    for (const line of model[0].split('\n')) {
      const mapped = line.match(/@map\("(\w+)"\)/);
      if (mapped) {
        columns.add(mapped[1]);
        continue;
      }
      const bare = line.match(/^\s{2}(\w+)\s+\w/);
      if (bare) {
        columns.add(bare[1]);
      }
    }
    return columns;
  };

  it.each(Object.keys(tables))('has every column %s needs', (model) => {
    const table = tables[model];
    const tableName = table.modelName ?? model;
    const columns = columnsOf(tableName);

    const missing = Object.entries(table.fields)
      .map(([name, field]) => field.fieldName ?? name)
      .map(toSnakeCase)
      .filter((column) => !columns.has(column));

    expect(missing, `${tableName} is missing: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('covers every table the plugin set declares', () => {
    // A plugin added without a migration is the same failure in a different
    // shape: the table simply does not exist.
    const missing = Object.entries(tables)
      .map(([model, table]) => table.modelName ?? model)
      .filter((name) => !schema.includes(`@@map("${name}")`));

    expect(
      missing,
      `tables absent from the schema: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});

function toSnakeCase(name: string): string {
  return name.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase();
}
