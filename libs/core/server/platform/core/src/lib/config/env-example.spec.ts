import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { envSchema, workerEnvSchema } from './env.schema.js';

// src/lib/config -> src/lib -> src -> core -> platform -> server -> core ->
// libs -> the workspace root.
const EXAMPLE = join(
  import.meta.dirname,
  '../../../../../../../..',
  '.env.example',
);

/**
 * Variables the example file names that the schema does not.
 *
 * Each is read by something other than a Nest application, so the schema is
 * not where it belongs — and leaving it out of the example instead would hide
 * it from the person setting the project up, which is the failure this whole
 * file exists to prevent.
 */
const OUTSIDE_THE_SCHEMA = new Set([
  // The Prisma CLI's, not the service's: DDL runs as the owner.
  'MIGRATION_DATABASE_URL',
  'SHADOW_DATABASE_URL',
  // Next.js inlines these at build time; they never reach a Nest process.
  'NEXT_PUBLIC_API_ORIGIN',
  'NEXT_PUBLIC_DEFAULT_LOCALE',
  'APP_TIME_ZONE',
  // Phases that have not been built. They are in the example because the
  // compose file starts the services, and a developer meeting one with no idea
  // why deserves the line.
  //
  // The storage variables were here until storage was built; they are in the
  // schema now, and this test is what noticed the list had gone stale. The
  // collector's address left the same way when tracing arrived.
  'SMTP_HOST',
  'SMTP_PORT',
]);

const named = (source: string): Set<string> => {
  const names = new Set<string>();

  // A commented-out line counts: that is how a variable whose default is the
  // right answer is documented, and it still tells somebody it exists.
  for (const match of source.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }

  return names;
};

/**
 * `.env.example` against the schema that validates the real thing.
 *
 * A variable the schema accepts and the example never mentions is not
 * configurable in any way that matters: nobody knows it is there. That is how
 * `NODE_ENV` and `LOG_LEVEL` came to be missing — both settable, both
 * validated, neither written down.
 *
 * The other direction is the one that rots: a variable removed from the schema
 * leaves a line in the example that looks like it does something.
 */
describe('the example environment and the schema it stands for', () => {
  const example = named(readFileSync(EXAMPLE, 'utf8'));
  const declared = new Set([
    ...Object.keys(envSchema.shape),
    ...Object.keys(workerEnvSchema.shape),
  ]);

  it('documents every variable the schema accepts', () => {
    const undocumented = [...declared]
      .filter((name) => !example.has(name))
      .sort();

    expect(undocumented).toEqual([]);
  });

  it('names nothing the schema has forgotten about', () => {
    const stale = [...example]
      .filter((name) => !declared.has(name) && !OUTSIDE_THE_SCHEMA.has(name))
      .sort();

    // A line here that no longer matches a schema key is either a variable
    // that was removed — and the example is now lying — or one that belongs in
    // the exemption list above with a reason beside it.
    expect(stale).toEqual([]);
  });

  it('exempts nothing that the schema actually declares', () => {
    // An exemption that stopped being true would silently excuse a real gap.
    expect([...OUTSIDE_THE_SCHEMA].filter((name) => declared.has(name))).toEqual(
      [],
    );
  });
});

describe('the example file is loaded into every task', () => {
  it('documents NODE_ENV without setting it', () => {
    // Nx loads `.env` into every task it runs, and `.env` is this file with
    // values filled in. `NODE_ENV=development` there is a value `next build`
    // and `webpack` see too, and it makes a production build a development
    // one — measured, as a prerender error in a page that is fine, hours after
    // `pnpm dev` appended the line.
    //
    // The variable still belongs in the file: somebody setting the project up
    // needs to know it exists. It belongs commented out.
    const assignments = readFileSync(EXAMPLE, 'utf8')
      .split(/\r?\n/)
      .filter((line) => /^\s*NODE_ENV\s*=/.test(line));

    expect(assignments).toEqual([]);
  });

  it('still names it, so nobody has to discover it from a stack trace', () => {
    expect(named(readFileSync(EXAMPLE, 'utf8')).has('NODE_ENV')).toBe(true);
  });
});
