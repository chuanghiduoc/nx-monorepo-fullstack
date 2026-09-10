/**
 * Every action the system can authorise, in one place.
 *
 * An action is `<resource>.<verb>`. The registry is the single source: it
 * produces the permission statements better-auth's access control is
 * configured with, so the permissions a role actually grants and the actions
 * the facade knows about cannot drift apart.
 *
 * The version exists so a cached decision can be invalidated when the policy
 * changes. Bump it in the same commit that changes the actions.
 */
export const ACTION_REGISTRY = {
  version: 3,
  resources: {
    organization: ['update', 'delete'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    apiKey: ['create', 'read', 'update', 'delete'],
    note: ['create', 'read', 'update', 'delete'],
    // An endpoint carries a secret and receives every event the organization
    // raises, so managing one is an administrative act rather than an
    // ordinary member's.
    webhook: ['create', 'read', 'update', 'delete'],
    // Uploading and downloading. No `update`: a file's bytes are not editable
    // and its state belongs to the worker, so there is no verb for it.
    file: ['create', 'read', 'delete'],
  },
} as const;

type Registry = typeof ACTION_REGISTRY;
type Resource = keyof Registry['resources'];

/** `"note.read"`, `"member.delete"` — checked at compile time. */
export type Action = {
  [R in Resource]: `${R & string}.${Registry['resources'][R][number] & string}`;
}[Resource];

export interface ParsedAction {
  readonly resource: string;
  readonly verb: string;
}

/**
 * Splits an action, or returns undefined when the registry does not contain
 * it. Undefined means deny: an action nobody declared cannot be granted by
 * any role, and treating an unknown string as permissible is how a typo
 * becomes an authorisation bypass.
 */
export function parseAction(action: string): ParsedAction | undefined {
  const separator = action.indexOf('.');
  if (separator <= 0) {
    return undefined;
  }

  const resource = action.slice(0, separator);
  const verb = action.slice(separator + 1);
  const verbs: readonly string[] | undefined = (
    ACTION_REGISTRY.resources as Record<string, readonly string[]>
  )[resource];

  return verbs?.includes(verb) ? { resource, verb } : undefined;
}

/**
 * The statements better-auth's `createAccessControl` expects.
 *
 * Returned as a mutable copy: better-auth stores what it is given, and a
 * frozen registry object leaking into its internals would be a surprise
 * nobody needs.
 */
export function permissionStatements(): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(ACTION_REGISTRY.resources).map(([resource, verbs]) => [
      resource,
      [...verbs],
    ]),
  );
}
