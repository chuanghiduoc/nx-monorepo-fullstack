'use client';

import { apiKeyClient } from '@better-auth/api-key/client';
import {
  adminClient,
  multiSessionClient,
  organizationClient,
  twoFactorClient,
} from 'better-auth/client/plugins';
import type { AuthQueryState } from 'better-auth/client';
import { createAuthClient } from 'better-auth/react';

/**
 * Builds the client, in a function so its type has a name.
 *
 * Assigning the call directly to an exported constant leaves a type the
 * compiler can only describe by pointing inside better-auth's own build
 * output, which declaration emit refuses to write down. Naming it here is the
 * same shape the server uses for its own instance.
 */
function createClient() {
  return createAuthClient({
    // The public origin of the edge, never the API's own address. A browser
    // that knew where the service actually lives would be one deploy away
    // from talking to it directly and skipping everything in between.
    baseURL: process.env['NEXT_PUBLIC_API_ORIGIN'] ?? 'http://localhost:3000',
    plugins: [
      organizationClient(),
      twoFactorClient(),
      multiSessionClient(),
      adminClient(),
      apiKeyClient(),
    ],
  });
}

export type AuthClient = ReturnType<typeof createClient>;

/** The user and the session the client infers from its own plugin list. */
type Session = AuthClient['$Infer']['Session'];

/**
 * What every `useSession` caller reads: the data, an error, and the two
 * pending flags.
 *
 * Written out rather than inferred, and that is also what keeps the build
 * working: the client's own type mentions this one, and the compiler will only
 * write a type into a declaration file if it can name it through a path the
 * package publishes. Naming it here gives it one.
 */
export type SessionState = AuthQueryState<Session>;

/**
 * The browser's half of authentication.
 *
 * Its plugin list mirrors the server's: the client only knows about endpoints
 * whose plugin it was given, so a mismatch shows up as a missing method at
 * compile time rather than a 404 in front of somebody.
 */
export const authClient: AuthClient = createClient();
