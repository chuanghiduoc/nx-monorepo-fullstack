/**
 * Marker nestjs-zod leaves on a property whose JSON Schema `type` was not a
 * plain string — for a nullable, `["string", "null"]`. It is removed again by
 * `cleanupOpenApiDoc`, so this check must run on the raw document.
 */
const EMPTY_TYPE_MARKER = 'x-nestjs_zod-empty-type';

interface SchemaLike {
  [EMPTY_TYPE_MARKER]?: boolean;
  type?: unknown;
  properties?: Record<string, SchemaLike>;
  items?: SchemaLike;
  anyOf?: SchemaLike[];
  oneOf?: SchemaLike[];
  allOf?: SchemaLike[];
}

/**
 * Refuses a document in which a nullable field became an array.
 *
 * Zod 4 emits a bare nullable primitive as `type: ["string", "null"]`.
 * @nestjs/swagger reads that as its legacy "array of types" form and rewrites
 * it to `type: "array", items: { type: "string" }` — silently. The generated
 * client then believed `nextCursor` was a list of strings, and no test noticed
 * because the runtime never validates response shapes against the document.
 *
 * The fix on the schema side is to give the branch a constraint or a
 * description (`z.string().max(n).nullable()`), which makes Zod emit `anyOf`
 * instead. This check is what turns the next occurrence into a build failure
 * with the property named, rather than a wrong contract in production.
 */
export function assertNoCollapsedNullables(document: {
  components?: { schemas?: Record<string, unknown> };
}): void {
  const offenders: string[] = [];

  for (const [name, schema] of Object.entries(
    document.components?.schemas ?? {},
  )) {
    walk(schema as SchemaLike, name, offenders);
  }

  if (offenders.length > 0) {
    throw new Error(
      `OpenAPI: nullable field(s) collapsed to an array — ${offenders.join(', ')}. ` +
        'Give the Zod branch a constraint or description (e.g. z.string().max(n).nullable()) ' +
        'so it emits anyOf; see apps/core/api/src/app/openapi/assert-no-collapsed-nullables.ts.',
    );
  }
}

function walk(
  schema: SchemaLike | undefined,
  path: string,
  offenders: string[],
): void {
  if (!schema || typeof schema !== 'object') {
    return;
  }

  if (schema[EMPTY_TYPE_MARKER] === true && schema.type === 'array') {
    offenders.push(path);
  }

  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    walk(property, `${path}.${key}`, offenders);
  }
  walk(schema.items, `${path}[]`, offenders);
  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    schema[combinator]?.forEach((branch, index) =>
      walk(branch, `${path}.${combinator}[${index}]`, offenders),
    );
  }
}
