import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// tools/ -> the library root, where prisma/ lives.
const SCHEMA = join(import.meta.dirname, '..', 'prisma', 'schema.prisma');

/**
 * How a table relates to a tenant. Declared in a comment above each model;
 * nothing is inferred from a column name, because an organization column on an
 * authentication table would otherwise imply a policy that must not exist
 * there.
 */
const MODEL_CLASSES = [
  'GLOBAL',
  'TENANT_OWNED',
  'TENANT_OPTIONAL',
  'SYSTEM',
  'AUTH',
] as const;

export type ModelClass = (typeof MODEL_CLASSES)[number];

/** Classes whose rows belong to a tenant, and so need one to be queried. */
export const TENANT_SCOPED_CLASSES: readonly ModelClass[] = [
  'TENANT_OWNED',
  'TENANT_OPTIONAL',
];

/**
 * Reads every model's class straight from the schema.
 *
 * Build-time only, and it lives in `tools/` to keep it that way. It reads a
 * file with `import.meta.dirname`, which webpack cannot express in CommonJS:
 * pulling it into the bundle made the whole bundle parse as an ES module, and
 * the service died on its first `require`.
 *
 * The schema is the source: a checked-in list would be a second place to
 * remember, and the one that gets forgotten. An unclassified model is an
 * error rather than a default — guessing would guess towards less protection.
 */
export function readModelClasses(schemaPath = SCHEMA): Map<string, ModelClass> {
  const schema = readFileSync(schemaPath, 'utf8');
  const classes = new Map<string, ModelClass>();

  // A model is preceded by its documentation comments; the class line is the
  // one that starts `/// class:`.
  const pattern = /((?:^\/\/\/.*\n)+)^model\s+(\w+)\s*\{/gm;
  const declared = new Set<string>();

  for (const [, comments, model] of schema.matchAll(pattern)) {
    const found = comments.match(/^\/\/\/\s*class:\s*(\w+)/m);
    if (!found) {
      continue;
    }

    const name = found[1] as ModelClass;
    if (!MODEL_CLASSES.includes(name)) {
      throw new Error(
        `Model ${model} declares an unknown class "${name}". Known classes: ${MODEL_CLASSES.join(', ')}`,
      );
    }

    classes.set(model, name);
    declared.add(model);
  }

  const allModels = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
  const missing = allModels.filter((model) => !declared.has(model));

  if (missing.length > 0) {
    throw new Error(
      `These models declare no class: ${missing.join(', ')}. ` +
        `Add a "/// class: <${MODEL_CLASSES.join('|')}>" line above each.`,
    );
  }

  return classes;
}

/**
 * Prisma names its delegates in camelCase (`demoItem`), the schema names
 * models in PascalCase (`DemoItem`). The guard sees the former.
 */
export function tenantScopedDelegates(schemaPath = SCHEMA): Set<string> {
  const scoped = new Set<string>();

  for (const [model, name] of readModelClasses(schemaPath)) {
    if (TENANT_SCOPED_CLASSES.includes(name)) {
      scoped.add(model.charAt(0).toLowerCase() + model.slice(1));
    }
  }

  return scoped;
}
