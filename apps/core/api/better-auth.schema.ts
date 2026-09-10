import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';

import {
  SCHEMA_GENERATION_TUNING,
  authOptionsFor,
} from '@workspace/core-server-feature-auth';

/**
 * Configuration for `@better-auth/cli generate` only.
 *
 * The CLI derives the schema from the plugin list and the adapter's dialect;
 * it never connects, so the client below is a stand-in. The running service's
 * configuration (`auth.service.ts`) imports the same `authOptions`, so the
 * generated schema always matches what the service will ask the database for.
 *
 * Regenerate with:
 *   pnpm dlx @better-auth/cli@latest generate \
 *     --config apps/core/api/better-auth.schema.ts --output <file> --yes
 */
/**
 * A stand-in for the Prisma client.
 *
 * The CLI reads the adapter's dialect and never issues a query, so nothing is
 * called on this. Importing the real client would drag the generated code into
 * a config file that has to load before that code exists.
 */
const unusedClient = {} as Parameters<typeof prismaAdapter>[0];

export const auth = betterAuth({
  // The generator reads the plugin list and the adapter's dialect; how long a
  // session lives has no bearing on the tables, so the defaults are honest
  // here in a way reading an unvalidated environment was not.
  ...authOptionsFor(SCHEMA_GENERATION_TUNING),
  database: prismaAdapter(unusedClient, { provider: 'postgresql' }),
  secret: 'schema-generation-only',
  baseURL: 'http://localhost:3000',
});
