import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';

import { authOptions } from './src/app/auth/auth.options';

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
export const auth = betterAuth({
  ...authOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the CLI only
  // reads the adapter's dialect; it never issues a query, and typing a real
  // client here would drag the generated Prisma client into a config file that
  // must load before that client exists.
  database: prismaAdapter({} as any, { provider: 'postgresql' }),
  secret: 'schema-generation-only',
  baseURL: 'http://localhost:3000',
});
