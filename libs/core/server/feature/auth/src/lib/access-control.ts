import { permissionStatements } from '@workspace/core-server-authz';
import { createAccessControl } from 'better-auth/plugins/access';

/**
 * The permission vocabulary, taken from the action registry rather than
 * repeated here.
 *
 * Two lists would drift the first time someone added a verb to one of them,
 * and the failure would be silent in the worst direction: the authorisation
 * facade would allow an action the auth library never grants, or the other way
 * round. One list means a new verb reaches both by construction.
 */
export const statements = permissionStatements();

export const ac = createAccessControl(statements);

/**
 * Which verbs each role gets.
 *
 * These assignments stay written out: they are a product decision, not a
 * vocabulary. An organization that wants roles of its own uses the dynamic
 * roles the auth library supports, validated against the same statements.
 */

/** Full control of the organization, including deleting it. */
export const owner = ac.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  apiKey: ['create', 'read', 'update', 'delete'],
  note: ['create', 'read', 'update', 'delete'],
  webhook: ['create', 'read', 'update', 'delete'],
  file: ['create', 'read', 'delete'],
});

/** Runs the organization day to day; cannot delete it. */
export const admin = ac.newRole({
  organization: ['update'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  apiKey: ['create', 'read', 'update', 'delete'],
  note: ['create', 'read', 'update', 'delete'],
  webhook: ['create', 'read', 'update', 'delete'],
  file: ['create', 'read', 'delete'],
});

/** Does the work, changes nothing about the organization itself. */
export const member = ac.newRole({
  apiKey: ['read'],
  note: ['create', 'read', 'update', 'delete'],
  // Read only: seeing where the organization's events go is useful when a
  // delivery fails, and an endpoint's secret is not readable by anyone.
  webhook: ['read'],
  // Uploading is ordinary work, which is what a member does.
  file: ['create', 'read', 'delete'],
});

export const roles = { owner, admin, member };

/**
 * The same role definitions, in the shape the authorization facade evaluates.
 *
 * Derived rather than written twice: the facade and the auth library must
 * agree about what a role grants, and two lists would disagree the first time
 * one of them changed.
 */
export const rolePermissions: Record<string, Record<string, string[]>> =
  Object.fromEntries(
    Object.entries(roles).map(([name, role]) => [
      name,
      Object.fromEntries(
        Object.entries(role.statements as Record<string, readonly string[]>).map(
          ([resource, verbs]) => [resource, [...verbs]],
        ),
      ),
    ]),
  );
