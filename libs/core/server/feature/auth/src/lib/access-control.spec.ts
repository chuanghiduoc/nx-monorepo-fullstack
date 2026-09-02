import { ACTION_REGISTRY } from '@workspace/core-server-authz';
import { describe, expect, it } from 'vitest';

import { roles, statements } from './access-control.js';

describe('the permission vocabulary', () => {
  it('is the action registry, not a second copy of it', () => {
    expect(Object.keys(statements).sort()).toEqual(
      Object.keys(ACTION_REGISTRY.resources).sort(),
    );

    for (const [resource, verbs] of Object.entries(ACTION_REGISTRY.resources)) {
      expect(statements[resource], resource).toEqual([...verbs]);
    }
  });

  it('grants every role only verbs the registry declares', () => {
    // A role naming a verb nobody declared would be granted by the auth
    // library and refused by the facade — an authorisation that half exists.
    for (const [name, role] of Object.entries(roles)) {
      for (const [resource, verbs] of Object.entries(role.statements)) {
        const declared: readonly string[] =
          (ACTION_REGISTRY.resources as Record<string, readonly string[]>)[
            resource
          ] ?? [];

        for (const verb of verbs as string[]) {
          expect(declared, `${name} grants ${resource}.${verb}`).toContain(
            verb,
          );
        }
      }
    }
  });

  it('gives the owner everything, and the member less', () => {
    // Read through a widened view: each role's type names only the resources
    // it was given, so indexing one with a resource it lacks is a type error
    // rather than the `undefined` the assertion is about.
    const granted = (role: keyof typeof roles, resource: string): string[] =>
      (roles[role].statements as unknown as Record<string, string[]>)[
        resource
      ] ?? [];

    expect(granted('owner', 'organization')).toContain('delete');
    expect(granted('member', 'organization')).not.toContain('delete');
  });
});
