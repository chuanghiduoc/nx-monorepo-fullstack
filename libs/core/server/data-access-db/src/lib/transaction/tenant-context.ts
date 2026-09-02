/**
 * Who a unit of work runs as. Declared explicitly, never inferred: the kind
 * decides which GUCs the transaction sets, and therefore which rows RLS lets
 * it see (spec §6.5).
 *
 * - `org`: a member acting inside an organization — both GUCs are set.
 * - `user`: a signed-in user with no active organization (B2C) — only the
 *   user GUC, so tenant-optional rows with a null org still resolve.
 * - `system`: relays, schedulers, migrations — no tenant GUC at all.
 */
export type TenantContext =
  | { readonly kind: 'org'; readonly orgId: string; readonly userId: string }
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'system' };

export type TenantScopedContext = Exclude<TenantContext, { kind: 'system' }>;

export const SYSTEM_CONTEXT: TenantContext = { kind: 'system' };

export function sameTenantContext(
  left: TenantContext,
  right: TenantContext,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case 'org':
      return (
        right.kind === 'org' &&
        left.orgId === right.orgId &&
        left.userId === right.userId
      );
    case 'user':
      return right.kind === 'user' && left.userId === right.userId;
    case 'system':
      return true;
    default:
      return assertNever(left);
  }
}

export function describeTenantContext(context: TenantContext): string {
  switch (context.kind) {
    case 'org':
      return `org ${context.orgId} / user ${context.userId}`;
    case 'user':
      return `user ${context.userId}`;
    case 'system':
      return 'system';
    default:
      return assertNever(context);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled tenant context: ${JSON.stringify(value)}`);
}
