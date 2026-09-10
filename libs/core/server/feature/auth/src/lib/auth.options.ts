import { apiKey } from '@better-auth/api-key';
import type { BetterAuthOptions } from 'better-auth';
import {
  admin,
  multiSession,
  organization,
  twoFactor,
} from 'better-auth/plugins';

import { ac, roles } from './access-control.js';

/**
 * The numbers an operator can move, and what they are when nobody has.
 *
 * These used to be read from `process.env` at the top of this file, and that
 * was wrong in a way nothing reported. Measured: `ConfigModule.forRoot` is what
 * loads `.env` into `process.env`, and it runs when the application module's
 * decorator is evaluated — after every `import` in that file has already run,
 * including this one. So a value set in `.env` reached `AppConfig` and never
 * reached better-auth: the schema said one thing, the running service did
 * another, and `SESSION_MAX_AGE_SECONDS` in a `.env` was silently ignored.
 *
 * They are arguments now. The defaults below exist only for the schema
 * generator, which imports this file to read the plugin list and does not care
 * how long a session lives.
 */
export interface AuthTuning {
  readonly sessionMaxAgeSeconds: number;
  readonly sessionUpdateAgeSeconds: number;
  readonly rateLimitMax: number;
  readonly credentialMaxAttempts: number;
}

export const SCHEMA_GENERATION_TUNING: AuthTuning = {
  sessionMaxAgeSeconds: 60 * 60 * 24 * 7,
  sessionUpdateAgeSeconds: 60 * 60 * 24,
  rateLimitMax: 300,
  credentialMaxAttempts: 10,
};

/**
 * How hard a caller may try, per address.
 *
 * Stated rather than inherited. The library turns its own limiter on in
 * production and off everywhere else, with a separate and much tighter rule
 * for the credential routes — so the behaviour an operator meets in
 * production is one nothing in development ever shows them, and nothing here
 * would have said so.
 *
 * The general allowance is deliberately loose: it covers reads like
 * `get-session`, which every page makes. The credential rule is the one that
 * matters, and it stays close to the library's default because guessing a
 * password is exactly what it is there to slow down.
 */
const RATE_LIMIT_WINDOW_SECONDS = 60;

const CREDENTIAL_WINDOW_SECONDS = 60;

/**
 * Everything about authentication except where it stores data.
 *
 * The database adapter is supplied separately: the running service hands it a
 * client wired to the connection pool Nest owns (`AuthService`), while the
 * schema generator needs the plugin list and nothing else. Splitting it here
 * is what keeps those two from drifting — the alternative is a second config
 * file that quietly falls behind the real one.
 *
 * A function rather than a constant, because the numbers above have to come
 * from the validated configuration and that does not exist when this module is
 * imported. `authOptionsFor(SCHEMA_GENERATION_TUNING)` is what the generator
 * uses; the service passes what `AppConfig` validated.
 *
 * `AUTH_RATE_LIMIT_MAX` is loose on purpose — it covers reads like
 * `get-session`, which every page makes, so a person browsing normally must
 * never meet it. `AUTH_CREDENTIAL_MAX_ATTEMPTS` is the one that matters: ten
 * is right for a deployment, where each person arrives from their own address,
 * and a test rig needs more because every browser, worker and account it
 * creates share one. Raising it is a decision about the rig, and it has to be
 * visible as one.
 */
export function authOptionsFor(tuning: AuthTuning) {
  const {
    sessionMaxAgeSeconds: SESSION_MAX_AGE_SECONDS,
    sessionUpdateAgeSeconds: SESSION_UPDATE_AGE_SECONDS,
    rateLimitMax: RATE_LIMIT_MAX_REQUESTS,
    credentialMaxAttempts: CREDENTIAL_MAX_ATTEMPTS,
  } = tuning;

  return {
    emailAndPassword: {
      enabled: true,
    },

    session: {
      expiresIn: SESSION_MAX_AGE_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },

    rateLimit: {
      // On everywhere, not only in production. A limit that appears for the
      // first time in production is one nobody has ever seen work, and the
      // first person to meet it is a user.
      enabled: true,
      window: RATE_LIMIT_WINDOW_SECONDS,
      max: RATE_LIMIT_MAX_REQUESTS,
      // Applied last, so these win over the library's own defaults and over a
      // plugin's — the two-factor plugin ships three attempts per ten seconds,
      // which is a number nothing in this repository chose or stated.
      //
      // Wildcards rather than exact paths: `/sign-in` covers the social and
      // one-time-code routes as they are enabled, and a rule that named only
      // `/sign-in/email` would silently stop covering the way people sign in.
      customRules: {
        '/sign-in/*': {
          window: CREDENTIAL_WINDOW_SECONDS,
          max: CREDENTIAL_MAX_ATTEMPTS,
        },
        '/sign-up/*': {
          window: CREDENTIAL_WINDOW_SECONDS,
          max: CREDENTIAL_MAX_ATTEMPTS,
        },
        '/two-factor/*': {
          window: CREDENTIAL_WINDOW_SECONDS,
          max: CREDENTIAL_MAX_ATTEMPTS,
        },
        '/change-password': {
          window: CREDENTIAL_WINDOW_SECONDS,
          max: CREDENTIAL_MAX_ATTEMPTS,
        },
        '/change-email': {
          window: CREDENTIAL_WINDOW_SECONDS,
          max: CREDENTIAL_MAX_ATTEMPTS,
        },
      },
    },

    advanced: {
      database: {
        // PostgreSQL generates every id with uuidv7. Letting
        // better-auth generate them too would put two kinds of id in one
        // database and lose the time-ordering the indexes depend on.
        generateId: false,
      },
      // Behind Caddy the client address and protocol arrive in X-Forwarded-*.
      useSecureCookies: process.env['NODE_ENV'] === 'production',
    },

    plugins: [
      organization({
        ac,
        roles,
        // Roles an owner defines at runtime, on top of the three above.
        dynamicAccessControl: { enabled: true },
      }),
      admin({ ac, roles }),
      twoFactor(),
      // Device sessions: list them, revoke one, keep the others.
      multiSession(),
      apiKey({
        // Left at its default, and asserted by a test: with it on, a valid key
        // would authenticate *every* endpoint, including routes that are meant
        // to require a session. The vendor's own documentation calls that
        // "not recommended for production use".
        enableSessionForAPIKeys: false,
      }),
    ],
  } satisfies Omit<BetterAuthOptions, 'database'>;
}

/**
 * The shape the schema generator and the type system need.
 *
 * `typeof authOptionsFor` would be a function type; this is what it produces,
 * which is what `betterAuth` is spread with.
 */
export type AuthOptions = ReturnType<typeof authOptionsFor>;

