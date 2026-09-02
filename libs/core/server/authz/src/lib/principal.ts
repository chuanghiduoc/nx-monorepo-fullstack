/**
 * Who is asking, resolved once per request before any transaction opens.
 *
 * Everything a permission decision needs is on this value, because the facade
 * is not allowed to query: better-auth's adapter reaches the root client, and
 * the Phase 2 guard refuses that inside a transaction — which is exactly where
 * a service calls `authz.require(...)`.
 */
export type Principal = UserPrincipal | ApiKeyPrincipal | SystemPrincipal;

interface PrincipalBase {
  /** Organization the request acts in, when one is active. */
  readonly orgId?: string;
  /**
   * Permissions granted directly, beyond what the roles carry. An API key
   * uses this exclusively; a user rarely needs it.
   */
  readonly permissions?: Permissions;
}

export interface UserPrincipal extends PrincipalBase {
  readonly type: 'user';
  /** The user the decision is made for. */
  readonly id: string;
  /**
   * The real account behind an impersonated session, when an administrator is
   * acting as someone else. Checks use `id`; the audit record carries both,
   * because "who did this" and "whose permissions allowed it" are different
   * questions.
   */
  readonly actorId?: string;
  readonly roles: readonly string[];
}

export interface ApiKeyPrincipal extends PrincipalBase {
  readonly type: 'apiKey';
  readonly id: string;
  /** The user who issued the key; a key never inherits their permissions. */
  readonly issuerId: string;
  readonly permissions: Permissions;
}

/** Relays, schedulers and migrations. Not reachable from an HTTP request. */
export interface SystemPrincipal {
  readonly type: 'system';
  readonly id: string;
}

/** `{ resource: [verb,...] }` — the shape better-auth's access control uses. */
export type Permissions = Readonly<Record<string, readonly string[]>>;

export function describePrincipal(principal: Principal): string {
  switch (principal.type) {
    case 'user':
      return principal.actorId
        ? `user ${principal.id} (impersonated by ${principal.actorId})`
        : `user ${principal.id}`;
    case 'apiKey':
      return `api key ${principal.id} issued by ${principal.issuerId}`;
    case 'system':
      return `system ${principal.id}`;
    default:
      return assertNever(principal);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled principal: ${JSON.stringify(value)}`);
}
