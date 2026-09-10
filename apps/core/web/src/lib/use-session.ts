'use client';

import { authClient, type SessionState } from './auth-client';

/**
 * The session, read in one place.
 *
 * Every screen needs it and the shape is not obvious — `data` is null while it
 * loads *and* when nobody is signed in, so a component that checks only `data`
 * reports "signed out" during the first render of every page.
 */
export function useSession(): SessionState {
  return authClient.useSession();
}

export interface ActiveOrganization {
  /** Undefined while the session loads, and for a person in no organization. */
  readonly organisation: string | undefined;
  readonly pending: boolean;
}

/**
 * Which organization the session is acting in.
 *
 * Separate from the session itself because that is the only part of it most
 * screens care about, and because "still loading" and "no organization" mean
 * different things on screen: one is a spinner, the other is an explanation.
 */
export function useActiveOrganization(): ActiveOrganization {
  const { data, isPending } = useSession();

  return {
    organisation: data?.session.activeOrganizationId ?? undefined,
    pending: isPending,
  };
}
