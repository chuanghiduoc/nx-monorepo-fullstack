/**
 * The single definition of the dependency matrix (spec §4).
 *
 * `@nx/enforce-module-boundaries` options replace rather than merge, so any
 * project that needs to adjust one option would otherwise have to restate the
 * whole matrix — and the copies would drift. Projects import this instead.
 */
export const depConstraints = [
  // scope: a product scope reaches only itself and shared.
  {
    sourceTag: 'scope:shared',
    onlyDependOnLibsWithTags: ['scope:shared'],
  },
  {
    sourceTag: 'scope:core',
    onlyDependOnLibsWithTags: ['scope:core', 'scope:shared'],
  },

  // platform: web and node never meet; the door between them is a generated
  // API client, which is platform:shared.
  {
    sourceTag: 'platform:web',
    onlyDependOnLibsWithTags: ['platform:web', 'platform:shared'],
  },
  {
    sourceTag: 'platform:node',
    onlyDependOnLibsWithTags: ['platform:node', 'platform:shared'],
  },
  {
    sourceTag: 'platform:shared',
    onlyDependOnLibsWithTags: ['platform:shared'],
  },

  // type: a feature may not import another feature — cross-feature
  // communication goes through domain events or shared contracts.
  {
    sourceTag: 'type:util',
    onlyDependOnLibsWithTags: ['type:util'],
  },
  {
    sourceTag: 'type:ui',
    onlyDependOnLibsWithTags: ['type:ui', 'type:util'],
  },
  {
    sourceTag: 'type:data-access',
    onlyDependOnLibsWithTags: ['type:data-access', 'type:util'],
  },
  {
    sourceTag: 'type:feature',
    onlyDependOnLibsWithTags: ['type:ui', 'type:data-access', 'type:util'],
  },
  {
    sourceTag: 'type:app',
    onlyDependOnLibsWithTags: [
      'type:feature',
      'type:ui',
      'type:data-access',
      'type:util',
    ],
  },
];

/**
 * Phase 2+ placeholder for spec §4 rules 5 and 5b: Prisma may only be imported
 * inside data-access-db, BullMQ only inside the queue facade, the AWS SDK only
 * inside feature-storage. `@nx/enforce-module-boundaries` supports this through
 * `bannedExternalImports` on the matching constraint — add it to the relevant
 * entry above as each library appears, rather than relying on review.
 */

/** Import paths every project is allowed to use regardless of tags. */
export const baseAllow = ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'];
