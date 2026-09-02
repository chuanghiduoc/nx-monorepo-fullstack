import { betterAuth } from 'better-auth';

/**
 * Spike configuration (Phase 2, Task 1).
 *
 * The database adapter is deliberately absent: this proves the HTTP mounting
 * path on Fastify only. Phase 3 replaces this with the Prisma adapter plus the
 * organization, admin, api-key and multi-session plugins.
 */
export const auth = betterAuth({
  // In-memory only; every restart forgets everything. Enough to prove routing,
  // cookie handling and the Web Request/Response bridge work.
  database: undefined,
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:4200').split(
    ',',
  ),
  advanced: {
    // Behind Caddy (spec §6.18) the app sees the proxy, not the client. Fastify
    // must be told to trust the forwarded headers for secure cookies to work.
    useSecureCookies: process.env.NODE_ENV === 'production',
  },
});
