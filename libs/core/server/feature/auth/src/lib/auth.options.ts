import { apiKey } from '@better-auth/api-key';
import type { BetterAuthOptions } from 'better-auth';
import {
  admin,
  multiSession,
  organization,
  twoFactor,
} from 'better-auth/plugins';

import { ac, roles } from './access-control.js';

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

/**
 * Everything about authentication except where it stores data.
 *
 * The database adapter is supplied separately: the running service hands it a
 * client wired to the connection pool Nest owns (`AuthService`), while the
 * schema generator needs the plugin list and nothing else. Splitting it here
 * is what keeps those two from drifting — the alternative is a second config
 * file that quietly falls behind the real one.
 */
export const authOptions = {
  emailAndPassword: {
    enabled: true,
  },

  session: {
    expiresIn: SESSION_MAX_AGE_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
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
