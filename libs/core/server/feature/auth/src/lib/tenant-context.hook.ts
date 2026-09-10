import type { Principal } from '@workspace/core-server-authz';
import {
  runRequestInContext,
  type RequestContext,
  type TenantContext,
} from '@workspace/core-server-core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';

import type { Auth } from './auth.service.js';

export const API_KEY_HEADER = 'x-api-key';

/**
 * What a request can resolve to. A system principal is not among them: relays
 * and schedulers do not arrive over HTTP, and leaving the case in the switch
 * would suggest they might.
 */
type RequestPrincipal = Exclude<Principal, { type: 'system' }>;

/**
 * Establishes who is asking, once, at the very start of a request.
 *
 * Two things make this the only sane place for it:
 *
 * Authentication reads the database through the root client, and the root
 * client refuses to be used while a transaction is open. Resolving here — in
 * `onRequest`, before any handler and therefore before any transaction — is
 * what keeps a permission check from having to query.
 *
 * And an API key must never open a session route. The two credentials are
 * read on separate branches: when `x-api-key` is present the request is a key
 * request and cookies are not consulted at all, so a leaked key cannot ride a
 * browser session, and a session cannot borrow a key's permissions.
 */
export function mountTenantContext(
  app: NestFastifyApplication,
  auth: Auth,
): void {
  const fastify = app.getHttpAdapter().getInstance();

  // Callback style deliberately: the request continues *inside*
  // `runRequestInContext`, which is what carries the store into the route
  // handler. An async hook would resolve identity correctly and then hand the
  // handler an empty context.
  fastify.addHook('onRequest', (request, _reply, done) => {
    resolvePrincipal(auth, request).then((principal) => {
      if (!principal) {
        // Anonymous. No context: a route that needs one says so, and a tenant
        // query without one throws rather than returning an empty list.
        done();
        return;
      }

      runRequestInContext(contextFor(principal), done);
    }, done);
  });
}

function resolvePrincipal(
  auth: Auth,
  request: FastifyRequest,
): Promise<RequestPrincipal | undefined> {
  return principalFromHeaders(auth, request.headers);
}

/**
 * The same resolution, from headers alone.
 *
 * Exported because a WebSocket handshake never reaches the Fastify hook above —
 * Socket.IO attaches to the raw HTTP server — and "who is this" must have one
 * implementation. Two would agree on the day they were written and disagree by
 * the time either was changed.
 */
export async function principalFromHeaders(
  auth: Auth,
  raw: Record<string, string | string[] | undefined>,
): Promise<RequestPrincipal | undefined> {
  const headers = fromNodeHeaders(raw);
  const apiKey = raw[API_KEY_HEADER];

  if (typeof apiKey === 'string' && apiKey.length > 0) {
    return resolveApiKey(auth, apiKey, headers);
  }

  return resolveSession(auth, headers);
}

async function resolveApiKey(
  auth: Auth,
  key: string,
  headers: Headers,
): Promise<RequestPrincipal | undefined> {
  const result = await auth.api.verifyApiKey({ body: { key }, headers });

  if (!result.valid || !result.key) {
    // An invalid key is the end of the request's identity. Falling through to
    // the session here is the mistake this whole branch exists to avoid.
    return undefined;
  }

  // `referenceId` is whoever the key was issued for — a user, or an
  // organization when the key belongs to one.
  const { id, referenceId, permissions } = result.key;

  return {
    type: 'apiKey',
    id,
    issuerId: referenceId,
    // A key acts for whoever it was issued for, with only the permissions
    // written on it — never the issuer's own.
    permissions: parsePermissions(permissions),
  };
}

async function resolveSession(
  auth: Auth,
  headers: Headers,
): Promise<RequestPrincipal | undefined> {
  const session = await auth.api.getSession({ headers });

  if (!session) {
    return undefined;
  }

  const orgId = session.session.activeOrganizationId ?? undefined;

  return {
    type: 'user',
    id: session.user.id,
    // An administrator acting as someone else: decisions follow the user
    // being impersonated, the audit trail keeps both.
    actorId: session.session.impersonatedBy ?? undefined,
    orgId,
    // Roles are membership of the *active* organization, not of the account.
    // The same person is often an owner in one organization and a member in
    // another, and a permission granted in one means nothing in the other.
    roles: orgId ? await rolesInActiveOrganization(auth, headers) : [],
  };
}

/**
 * The roles the active membership carries.
 *
 * A membership row holds them as one comma-separated string, which is how
 * better-auth stores a member with more than one role.
 */
async function rolesInActiveOrganization(
  auth: Auth,
  headers: Headers,
): Promise<string[]> {
  try {
    const member = await auth.api.getActiveMember({ headers });

    return typeof member?.role === 'string'
      ? member.role
          .split(',')
          .map((role) => role.trim())
          .filter(Boolean)
      : [];
  } catch {
    // No membership, or the organization went away between the session being
    // issued and this request. Either way the answer is no roles, which the
    // facade turns into a refusal rather than an accident.
    return [];
  }
}

/**
 * The tenant a request may read and write.
 *
 * A user with no active organization is not "no tenant": they are a tenant of
 * one, themselves, and rows they own with no organization are theirs. That is
 * the case the user-only context exists for.
 */
function contextFor(principal: RequestPrincipal): RequestContext {
  return { principal, tenant: tenantOf(principal) };
}

function tenantOf(principal: RequestPrincipal): TenantContext {
  switch (principal.type) {
    case 'apiKey':
      return principal.orgId
        ? { kind: 'org', orgId: principal.orgId, userId: principal.issuerId }
        : { kind: 'user', userId: principal.issuerId };
    case 'user':
      return principal.orgId
        ? { kind: 'org', orgId: principal.orgId, userId: principal.id }
        : { kind: 'user', userId: principal.id };
    default:
      return assertNever(principal);
  }
}

function parsePermissions(
  raw: string | Record<string, string[]> | null | undefined,
): Record<string, string[]> {
  if (!raw) {
    return {};
  }
  if (typeof raw !== 'string') {
    return raw;
  }

  try {
    return JSON.parse(raw) as Record<string, string[]>;
  } catch {
    // A key whose permissions cannot be read grants nothing. Guessing here
    // would be guessing in the direction of more access.
    return {};
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled principal: ${JSON.stringify(value)}`);
}
