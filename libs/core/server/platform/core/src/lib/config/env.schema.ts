import { z } from 'zod';

const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;

/**
 * The contract between the process and its environment.
 *
 * Validation runs at boot, so a missing or malformed variable stops the service
 * immediately with a message naming the variable — rather than surfacing as a
 * confusing failure on whichever request happens to need it first.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  PORT: z.coerce.number().int().positive().max(MAX_PORT).default(DEFAULT_PORT),

  // The application's own connection, as a role bound by row-level security.
  // Migrations use MIGRATION_DATABASE_URL and are not part of a running
  // service's configuration.
  DATABASE_URL: z
    .string()
    .refine(
      (value) =>
        value.startsWith('postgresql://') || value.startsWith('postgres://'),
      {
        message: 'DATABASE_URL must be a PostgreSQL connection string',
      },
    ),

  // Two Redis roles, never one instance: the queue requires noeviction while a
  // cache wants eviction, and a single instance cannot be both.
  REDIS_CRITICAL_URL: z
    .string()
    .refine(
      (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
      {
        message: 'REDIS_CRITICAL_URL must be a Redis connection string',
      },
    ),
  REDIS_CACHE_URL: z
    .string()
    .refine(
      (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
      {
        message: 'REDIS_CACHE_URL must be a Redis connection string',
      },
    ),

  // Rate limiting is configurable so operations can tighten it without a
  // rebuild, and so tests can exercise the limit without sending a hundred
  // requests.
  THROTTLE_TTL_MS: z.coerce.number().int().positive().default(60_000),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(100),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // Interactive API docs: on wherever a developer runs the
  // service, off in production unless someone turns it on deliberately.
  // Absent means "decide from NODE_ENV", which is why this is optional
  // rather than defaulted.
  DOCS_ENABLED: z.stringbool().optional(),

  // Signing key for sessions and tokens. No default: a default secret is a
  // published secret, and better-auth would happily boot with one.
  BETTER_AUTH_SECRET: z.string().min(32, {
    message: 'BETTER_AUTH_SECRET must be at least 32 characters',
  }),
  // The origin the browser reaches the API on — the edge, not the container.
  // better-auth derives cookie domains and callback URLs from it.
  BETTER_AUTH_URL: z.url().default('http://localhost:3000'),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:4200')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
});

export type AppEnv = z.infer<typeof envSchema>;
