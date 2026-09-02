import { ForbiddenException, Injectable, Logger } from '@nestjs/common';

import { parseAction, type Action } from './action-registry.js';
import {
  describePrincipal,
  type Permissions,
  type Principal,
} from './principal.js';

/** Extra facts a decision may depend on beyond the principal itself. */
export interface AuthorizationContext {
  /** Organization the resource belongs to. */
  readonly orgId?: string;
  readonly resourceId?: string;
  /** Owner of the resource, for the "your own" case. */
  readonly resourceOwnerId?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** What roles a given organization grants. Supplied at construction. */
export type RolePermissions = Readonly<Record<string, Permissions>>;

export interface Decision {
  readonly allowed: boolean;
  /** Why, for the log. Never sent to the client. */
  readonly reason: string;
}

const DENY_REASONS = {
  unknownAction: 'the action is not in the registry',
  wrongOrg: 'the principal is not acting in the resource’s organization',
  noGrant: 'no role or direct permission grants this action',
} as const;

/**
 * The single place a permission question is answered.
 *
 * Business code calls `require`; nothing re-implements `if (!can) throw`, so
 * every denial has the same shape, the same status and the same log record
 *
 * **It performs no I/O.** Everything a decision needs is on the principal,
 * resolved once per request before any transaction opens — because the
 * database call this would otherwise make is exactly the one the Phase 2
 * guard refuses from inside a transaction.
 */
@Injectable()
export class AuthzService {
  private readonly logger = new Logger(AuthzService.name);
  private readonly rolePermissions: RolePermissions;

  constructor(rolePermissions: RolePermissions) {
    this.rolePermissions = rolePermissions;
  }

  can(
    principal: Principal,
    action: Action | string,
    context: AuthorizationContext = {},
  ): boolean {
    return this.decide(principal, action, context).allowed;
  }

  canAll(
    principal: Principal,
    actions: readonly (Action | string)[],
    context: AuthorizationContext = {},
  ): boolean {
    return actions.every((action) => this.can(principal, action, context));
  }

  canAny(
    principal: Principal,
    actions: readonly (Action | string)[],
    context: AuthorizationContext = {},
  ): boolean {
    return actions.some((action) => this.can(principal, action, context));
  }

  /**
   * Throws a 403 whose body says nothing about why.
   *
   * The reason goes to the log, where an operator can read it. Telling the
   * client which rule failed turns the API into a map of the permission model.
   */
  require(
    principal: Principal,
    action: Action | string,
    context: AuthorizationContext = {},
  ): void {
    const decision = this.decide(principal, action, context);
    if (decision.allowed) {
      return;
    }

    this.logger.warn(
      `Denied ${action} for ${describePrincipal(principal)}: ${decision.reason}`,
      JSON.stringify({
        action,
        principalType: principal.type,
        principalId: principal.id,
        actorId: principal.type === 'user' ? principal.actorId : undefined,
        orgId: context.orgId ?? organizationOf(principal),
        resourceId: context.resourceId,
        reason: decision.reason,
      }),
    );

    throw new ForbiddenException('You are not allowed to perform this action.');
  }

  private decide(
    principal: Principal,
    action: string,
    context: AuthorizationContext,
  ): Decision {
    const parsed = parseAction(action);
    if (!parsed) {
      // Default deny, and the first branch on purpose: an action nobody
      // declared must never be permitted by a role that happens to name it.
      return { allowed: false, reason: DENY_REASONS.unknownAction };
    }

    switch (principal.type) {
      case 'system':
        // Relays and schedulers run outside any organization; their limits are
        // database grants (worker_user), not this facade.
        return { allowed: true, reason: 'system principal' };

      case 'apiKey':
        return this.fromPermissions(
          principal.permissions,
          parsed,
          principal,
          context,
          // A key carries its own permissions and never the issuer's: a key
          // made by an owner must not become an owner.
          'the key’s own permissions',
        );

      case 'user': {
        const granted = this.rolesOf(principal);
        return this.fromPermissions(
          merge(granted, principal.permissions),
          parsed,
          principal,
          context,
          'role',
        );
      }

      default:
        return assertNever(principal);
    }
  }

  private fromPermissions(
    permissions: Permissions,
    parsed: { resource: string; verb: string },
    principal: Principal,
    context: AuthorizationContext,
    source: string,
  ): Decision {
    const scoped = this.sameOrganization(principal, context);
    if (!scoped) {
      return { allowed: false, reason: DENY_REASONS.wrongOrg };
    }

    const verbs = permissions[parsed.resource] ?? [];
    if (verbs.includes(parsed.verb)) {
      return { allowed: true, reason: `granted by ${source}` };
    }

    return { allowed: false, reason: DENY_REASONS.noGrant };
  }

  /**
   * A permission granted in one organization means nothing in another.
   *
   * RLS enforces the same boundary in the database; this is the layer that
   * turns it into a 403 rather than an empty result.
   */
  private sameOrganization(
    principal: Principal,
    context: AuthorizationContext,
  ): boolean {
    if (!context.orgId) {
      return true;
    }
    return organizationOf(principal) === context.orgId;
  }

  private rolesOf(principal: { roles: readonly string[] }): Permissions {
    return principal.roles.reduce<Permissions>(
      (all, role) => merge(all, this.rolePermissions[role]),
      {},
    );
  }
}

/** A system principal belongs to no organization, which is not the same as undefined. */
function organizationOf(principal: Principal): string | undefined {
  return principal.type === 'system' ? undefined : principal.orgId;
}

function merge(left: Permissions, right: Permissions | undefined): Permissions {
  if (!right) {
    return left;
  }

  const merged: Record<string, string[]> = Object.fromEntries(
    Object.entries(left).map(([resource, verbs]) => [resource, [...verbs]]),
  );

  for (const [resource, verbs] of Object.entries(right)) {
    merged[resource] = [...new Set([...(merged[resource] ?? []), ...verbs])];
  }

  return merged;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled principal: ${JSON.stringify(value)}`);
}
