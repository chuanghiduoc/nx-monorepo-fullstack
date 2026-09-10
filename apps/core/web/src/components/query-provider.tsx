'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

const STALE_TIME_MS = 30_000;

/**
 * One query cache per browser tab.
 *
 * `useState` rather than a module-level constant: a module constant is shared
 * by every request the server renders, which means one reader's cached answers
 * can be handed to the next. Creating it in state keeps the cache inside the
 * tree that owns it.
 *
 * The cache is not keyed on the active organization. Keying it would remount
 * the whole tree the moment the session resolved, discarding anything already
 * typed and refetching whatever had already started; `useSwitchOrganization`
 * empties it at the one point where the tenant actually changes instead.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: STALE_TIME_MS,
            // A 403 does not become a 200 by asking again; only transport
            // failures are worth a second attempt.
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
