/**
 * How often an entitlement's allowance resets.
 *
 * `sliding` is deliberately absent. A sliding limit cannot be a counter row
 * keyed by a window start at all — it needs the individual events inside the
 * trailing period — so offering the name here would let a caller ask for a
 * sliding limit and silently receive a fixed one, which is the failure mode
 * worth the most trouble to prevent. It is recorded as an upgrade.
 */
export type QuotaWindow = 'daily' | 'monthly' | 'lifetime';

/**
 * The one window a lifetime entitlement ever has.
 *
 * `window_start` is part of a primary key and NOT NULL, so lifetime needs a
 * value. The epoch is the one value nobody can mistake for a boundary somebody
 * meant.
 */
export const LIFETIME_WINDOW_START = new Date(0);

/**
 * The start of the window a moment falls in.
 *
 * **In UTC, and that is a decision rather than an oversight.** A boundary in
 * the tenant's own zone would make this depend on a column in another table
 * and on a DST rule, and a tenant that changed its zone mid-month would move a
 * boundary underneath counters that already exist. The contract states the
 * rule so a tenant in UTC+7 knows its month rolls over at 07:00 local rather
 * than discovering it.
 *
 * Computed here and never passed in by a caller: two callers rounding
 * differently would split one window into two rows, and both halves would get
 * the whole limit.
 */
export function windowStart(window: QuotaWindow, at: Date): Date {
  switch (window) {
    case 'daily':
      return new Date(
        Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
      );
    case 'monthly':
      return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    case 'lifetime':
      return new Date(LIFETIME_WINDOW_START);
    default:
      return assertNever(window);
  }
}

/**
 * Refuses a window kind this function has not been taught about.
 *
 * The compiler catches a new member of the union here rather than letting the
 * switch fall through to a default that charges the wrong window.
 */
function assertNever(window: never): never {
  throw new Error(`Unknown quota window: ${String(window)}`);
}
