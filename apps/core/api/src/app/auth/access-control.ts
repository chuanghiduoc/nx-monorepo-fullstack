import { createAccessControl } from 'better-auth/plugins/access';

/**
 * Permission statements for organization roles.
 *
 * Phase 3 Task 5 replaces this literal with output generated from the
 * `ActionRegistry` in `@workspace/core-server-authz`, so that the permissions
 * better-auth enforces and the actions the authz facade knows about cannot
 * drift apart. Until then it is written once, here, and imported by both the
 * server config and the client.
 */
export const statements = {
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  apiKey: ['create', 'read', 'update', 'delete'],
  note: ['create', 'read', 'update', 'delete'],
} as const;

export const ac = createAccessControl(statements);

/** Full control of the organization, including deleting it. */
export const owner = ac.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  apiKey: ['create', 'read', 'update', 'delete'],
  note: ['create', 'read', 'update', 'delete'],
});

/** Runs the organization day to day; cannot delete it. */
export const admin = ac.newRole({
  organization: ['update'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  apiKey: ['create', 'read', 'update', 'delete'],
  note: ['create', 'read', 'update', 'delete'],
});

/** Does the work, changes nothing about the organization itself. */
export const member = ac.newRole({
  apiKey: ['read'],
  note: ['create', 'read', 'update', 'delete'],
});

export const roles = { owner, admin, member };
