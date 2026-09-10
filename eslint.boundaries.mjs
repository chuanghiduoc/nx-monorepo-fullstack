/**
 * The single definition of the dependency matrix.
 *
 * `@nx/enforce-module-boundaries` options replace rather than merge, so any
 * project that needs to adjust one option would otherwise have to restate the
 * whole matrix — and the copies would drift. Projects import this instead.
 */
/**
 * The ORM lives in the data-access library and nowhere else. Every constraint
 * whose source is not a data-access library bans the Prisma packages, so a
 * feature that reaches for `@prisma/client` fails lint rather than review. The
 * root client itself is not exported, so this closes the only other door.
 */
const ORM_PACKAGES = ['@prisma/*', 'prisma'];

/**
 * The queue driver, banned everywhere but the library that owns it.
 *
 * A separate list from the ORM one because the exemption is a different
 * library. `bannedExternalImports` attaches to a *tag*, and the rule has no
 * per-project escape, so a package is exempted by naming it in every
 * constraint except the one its owner carries.
 *
 * `type:data-access` alone cannot express that: both the ORM library and the
 * queue library carry it, so a list hung there would either ban a driver from
 * its own owner or exempt both libraries from both drivers. Each owner
 * therefore carries a second tag naming the driver it owns, and the two
 * constraints below ban the *other* driver from each. A project matching more
 * than one sourceTag collects every matching constraint, so `data-access-db`
 * is bound by `type:data-access` and by `driver:orm` together.
 */
const QUEUE_PACKAGES = ['bullmq'];

/** Everything a library outside its own facade may not reach for. */
const DRIVER_PACKAGES = [...ORM_PACKAGES, ...QUEUE_PACKAGES];

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
    bannedExternalImports: DRIVER_PACKAGES,
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
    bannedExternalImports: DRIVER_PACKAGES,
  },
  {
    // An end-to-end suite that drives a browser *and* starts the service it
    // talks to belongs to neither side. Its own tag keeps the rule above
    // meaning what it says for everything else, instead of widening the web
    // rule to admit a Node application.
    sourceTag: 'platform:e2e',
    onlyDependOnLibsWithTags: ['platform:e2e', 'platform:shared'],
  },

  // type: a feature may not import another feature — cross-feature
  // communication goes through domain events or shared contracts.
  {
    sourceTag: 'type:util',
    onlyDependOnLibsWithTags: ['type:util'],
    bannedExternalImports: DRIVER_PACKAGES,
  },
  {
    sourceTag: 'type:ui',
    onlyDependOnLibsWithTags: ['type:ui', 'type:util'],
    bannedExternalImports: DRIVER_PACKAGES,
  },
  {
    sourceTag: 'type:data-access',
    onlyDependOnLibsWithTags: ['type:data-access', 'type:util'],
  },

  // driver: the library that owns a driver is the only one exempt from it.
  {
    sourceTag: 'driver:orm',
    bannedExternalImports: QUEUE_PACKAGES,
  },
  {
    sourceTag: 'driver:queue',
    bannedExternalImports: ORM_PACKAGES,
  },
  {
    sourceTag: 'type:feature',
    onlyDependOnLibsWithTags: ['type:ui', 'type:data-access', 'type:util'],
    bannedExternalImports: DRIVER_PACKAGES,
  },
  {
    sourceTag: 'type:app',
    onlyDependOnLibsWithTags: [
      'type:feature',
      'type:ui',
      'type:data-access',
      'type:util',
    ],
    bannedExternalImports: DRIVER_PACKAGES,
  },
];

/**
 * The same treatment as each driver appears: the AWS SDK only inside the
 * storage feature, and so on — a new list beside these two, added to every
 * constraint except the tag its owner carries.
 *
 * `ioredis` is deliberately *not* on any of these lists, and it is now reached
 * from four places: the rate limiter, the queue, the shared-counter store and
 * the realtime bus. An earlier version of this note said a third would be the
 * trigger to restrict it. It was wrong about the criterion rather than about
 * the count.
 *
 * What makes a package worth restricting is having **one** owner, so the ban
 * expresses a boundary. Redis has four legitimate ones, each infrastructure in
 * its own right, so the list would be a list of exemptions — a name without a
 * boundary, which is exactly what this note exists to refuse. It becomes worth
 * restricting if a *feature* library ever reaches for a connection, which is a
 * different thing entirely.
 */

/** Import paths every project is allowed to use regardless of tags. */
export const baseAllow = ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'];
