import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readModelClasses, TENANT_SCOPED_CLASSES } from './model-classes.js';

/**
 * Writes the tenant-scoped delegate list from the schema.
 *
 * The list is generated rather than read at runtime because the schema is not
 * in the deployed bundle: reading it on module load worked in tests and made
 * the API fail to boot. It is committed, and a test fails when it and the
 * schema disagree, so the generated file cannot quietly fall behind.
 *
 *   pnpm nx run core-server-data-access-db:write-tenant-models
 */
const OUTPUT = join(
  import.meta.dirname,
  '..',
  'src',
  'lib',
  'tenancy',
  'tenant-scoped-models.ts',
);

const delegates = [...readModelClasses()]
  .filter(([, name]) => TENANT_SCOPED_CLASSES.includes(name))
  .map(([model]) => model.charAt(0).toLowerCase() + model.slice(1))
  .sort();

const contents = `// Generated from prisma/schema.prisma. Do not edit by hand.
//
// Run \`pnpm nx run core-server-data-access-db:write-tenant-models\` after
// changing a model's class comment; a test fails when this file and the
// schema disagree.

/** Prisma delegates whose rows belong to a tenant. */
export const TENANT_SCOPED_DELEGATES: ReadonlySet<string> = new Set([
${delegates.map((d) => `  '${d}',`).join('\n')}
]);
`;

writeFileSync(OUTPUT, contents);
console.log(`wrote ${OUTPUT} (${delegates.length} delegates)`);
