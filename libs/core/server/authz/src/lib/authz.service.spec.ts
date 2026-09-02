import { ForbiddenException, Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTION_REGISTRY, parseAction, permissionStatements } from './action-registry.js';
import { AuthzService, type RolePermissions } from './authz.service.js';
import type { Principal } from './principal.js';

const ORG = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER_ORG = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

const rolePermissions: RolePermissions = {
  owner: {
    organization: ['update', 'delete'],
    member: ['create', 'update', 'delete'],
    apiKey: ['create', 'read', 'update', 'delete'],
    note: ['create', 'read', 'update', 'delete'],
  },
  member: {
    note: ['create', 'read'],
    apiKey: ['read'],
  },
};

const authz = new AuthzService(rolePermissions);

const user = (roles: string[], overrides: Partial<Principal> = {}): Principal =>
  ({
    type: 'user',
    id: 'user-1',
    orgId: ORG,
    roles,
    ...overrides,
  }) as Principal;

describe('default deny', () => {
  it('refuses an action the registry does not contain', () => {
    // Cast through unknown on purpose: the typed Action union would reject
    // this at compile time, and the runtime path is what must hold when a
    // string arrives from a dynamic role or a configuration file.
    const typo = 'note.raed' as unknown as string;

    expect(authz.can(user(['owner']), typo)).toBe(false);
  });

  it('refuses an action on a resource nobody declared', () => {
    expect(authz.can(user(['owner']), 'invoice.approve')).toBe(false);
  });

  it('refuses a string that is not an action at all', () => {
    for (const nonsense of ['', 'note', '.read', 'note.']) {
      expect(authz.can(user(['owner']), nonsense), nonsense).toBe(false);
    }
  });

  it('refuses a role that grants nothing relevant', () => {
    expect(authz.can(user(['member']), 'organization.delete')).toBe(false);
  });
});

describe('roles', () => {
  it('allows what the role grants', () => {
    expect(authz.can(user(['member']), 'note.read')).toBe(true);
    expect(authz.can(user(['owner']), 'organization.delete')).toBe(true);
  });

  it('combines several roles', () => {
    expect(authz.can(user(['member', 'owner']), 'organization.delete')).toBe(true);
  });

  it('ignores a role that does not exist', () => {
    expect(authz.can(user(['ghost']), 'note.read')).toBe(false);
  });
});

describe('organization scope', () => {
  it('refuses a resource in another organization', () => {
    expect(
      authz.can(user(['owner']), 'note.update', { orgId: OTHER_ORG }),
    ).toBe(false);
  });

  it('allows a resource in the principal’s own organization', () => {
    expect(authz.can(user(['owner']), 'note.update', { orgId: ORG })).toBe(true);
  });
});

describe('api keys', () => {
  const key = (permissions: Record<string, string[]>): Principal => ({
    type: 'apiKey',
    id: 'key-1',
    issuerId: 'user-1',
    orgId: ORG,
    permissions,
  });

  it('is limited to its own permissions, never the issuer’s', () => {
    // The issuer is an owner; the key reads notes and nothing more. A key that
    // inherited its issuer's rights would turn every leaked key into an
    // account takeover.
    expect(authz.can(key({ note: ['read'] }), 'note.read')).toBe(true);
    expect(authz.can(key({ note: ['read'] }), 'note.delete')).toBe(false);
    expect(authz.can(key({ note: ['read'] }), 'organization.delete')).toBe(false);
  });

  it('is still bound by the organization', () => {
    expect(
      authz.can(key({ note: ['read'] }), 'note.read', { orgId: OTHER_ORG }),
    ).toBe(false);
  });
});

describe('impersonation', () => {
  it('decides for the impersonated user, not the administrator', () => {
    const impersonated = user(['member'], { actorId: 'admin-9' });

    // The administrator is an owner elsewhere; while impersonating, only the
    // impersonated user's permissions apply.
    expect(authz.can(impersonated, 'note.read')).toBe(true);
    expect(authz.can(impersonated, 'organization.delete')).toBe(false);
  });

  it('records both identities when it denies', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      expect(() =>
        authz.require(user(['member'], { actorId: 'admin-9' }), 'organization.delete'),
      ).toThrow(ForbiddenException);

      const [, details] = warn.mock.calls.at(-1) ?? [];
      expect(String(details)).toContain('admin-9');
      expect(String(details)).toContain('user-1');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('require', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('returns quietly when allowed', () => {
    expect(() => authz.require(user(['owner']), 'note.read')).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws a 403 that does not say why', () => {
    try {
      let thrown: unknown;
      try {
        authz.require(user(['member']), 'organization.delete');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ForbiddenException);
      const body = JSON.stringify((thrown as ForbiddenException).getResponse());
      // The client learns that it may not; it does not learn the rule.
      expect(body).not.toContain('role');
      expect(body).not.toContain('organization.delete');
    } finally {
      warn.mockRestore();
    }
  });

  it('logs the action, the principal type and the reason', () => {
    try {
      expect(() => authz.require(user(['member']), 'organization.delete')).toThrow();

      const [message, details] = warn.mock.calls.at(-1) ?? [];
      expect(String(message)).toContain('organization.delete');
      expect(String(details)).toContain('"principalType":"user"');
      expect(String(details)).toContain('no role or direct permission');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('canAny / canAll', () => {
  it('canAny needs one', () => {
    expect(
      authz.canAny(user(['member']), ['organization.delete', 'note.read']),
    ).toBe(true);
  });

  it('canAll needs every one', () => {
    expect(
      authz.canAll(user(['member']), ['note.read', 'organization.delete']),
    ).toBe(false);
    expect(authz.canAll(user(['member']), ['note.read', 'note.create'])).toBe(true);
  });
});

describe('the registry', () => {
  it('produces the statements better-auth is configured with', () => {
    const statements = permissionStatements();

    expect(Object.keys(statements).sort()).toEqual(
      Object.keys(ACTION_REGISTRY.resources).sort(),
    );
    expect(statements['note']).toEqual(['create', 'read', 'update', 'delete']);
  });

  it('hands out a copy, so a caller cannot edit the registry', () => {
    const statements = permissionStatements();
    statements['note'].push('destroy');

    expect(permissionStatements()['note']).not.toContain('destroy');
  });

  it('parses only declared actions', () => {
    expect(parseAction('note.read')).toEqual({ resource: 'note', verb: 'read' });
    expect(parseAction('note.destroy')).toBeUndefined();
  });

  it('carries a version, so a cached decision can be invalidated', () => {
    expect(ACTION_REGISTRY.version).toBeGreaterThan(0);
  });
});

describe('system principals', () => {
  it('are allowed, because their limits are database grants', () => {
    const system: Principal = { type: 'system', id: 'outbox-relay' };

    expect(authz.can(system, 'note.delete')).toBe(true);
  });

  it('are still refused an action nobody declared', () => {
    const system: Principal = { type: 'system', id: 'outbox-relay' };

    expect(authz.can(system, 'invoice.approve')).toBe(false);
  });
});
