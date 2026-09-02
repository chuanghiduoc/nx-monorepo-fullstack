// Generated from prisma/schema.prisma. Do not edit by hand.
//
// Run `pnpm nx run core-server-data-access-db:write-tenant-models` after
// changing a model's class comment; a test fails when this file and the
// schema disagree.

/** Prisma delegates whose rows belong to a tenant. */
export const TENANT_SCOPED_DELEGATES: ReadonlySet<string> = new Set([
  'bookmark',
  'note',
  'orgSetting',
]);
