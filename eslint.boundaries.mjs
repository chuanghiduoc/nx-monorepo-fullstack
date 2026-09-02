/**
 * The single definition of the dependency matrix (spec §4).
 *
 * `@nx/enforce-module-boundaries` options replace rather than merge, so any
 * project that needs to adjust one option would otherwise have to restate the
 * whole matrix — and the copies would drift. Projects import this instead.
 */
/**
 * Spec §4 rule 5: the ORM lives in data-access-db and nowhere else. Every
 * constraint whose source is not a data-access library bans the Prisma
 * packages, so a feature that reaches for `@prisma/client` fails lint rather
 * than review. The root client itself is not exported (see the library's
 * index), so this closes the only other door.
 */
const ORM_PACKAGES = ['@prisma/*', 'prisma'];

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
    bannedExternalImports: ORM_PACKAGES,
  },
  {
    sourceTag: 'platform:node',
    onlyDependOnLibsWithTags: ['platform:node', 'platform:shared'],
  },
  {
    // Also banned here: the generated API client is tagged type:data-access
    // (it is a data-access library for the frontend), which would otherwise
    // exempt a browser bundle from the ORM ban.
    sourceTag: 'platform:shared',
    onlyDependOnLibsWithTags: ['platform:shared'],
    bannedExternalImports: ORM_PACKAGES,
  },

  // type: a feature may not import another feature — cross-feature
  // communication goes through domain events or shared contracts.
  {
    sourceTag: 'type:util',
    onlyDependOnLibsWithTags: ['type:util'],
    bannedExternalImports: ORM_PACKAGES,
  },
  {
    sourceTag: 'type:ui',
    onlyDependOnLibsWithTags: ['type:ui', 'type:util'],
    bannedExternalImports: ORM_PACKAGES,
  },
  {
    sourceTag: 'type:data-access',
    onlyDependOnLibsWithTags: ['type:data-access', 'type:util'],
  },
  {
    sourceTag: 'type:feature',
    onlyDependOnLibsWithTags: ['type:ui', 'type:data-access', 'type:util'],
    bannedExternalImports: ORM_PACKAGES,
  },
  {
    sourceTag: 'type:app',
    onlyDependOnLibsWithTags: [
      'type:feature',
      'type:ui',
      'type:data-access',
      'type:util',
    ],
    bannedExternalImports: ORM_PACKAGES,
  },
];

/**
 * Spec §4 rule 5 continues as each library appears: BullMQ only inside the
 * queue facade, the AWS SDK only inside feature-storage — add to the banned
 * lists above the same way ORM_PACKAGES is, rather than relying on review.
 */

/** Import paths every project is allowed to use regardless of tags. */
export const baseAllow = ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'];
