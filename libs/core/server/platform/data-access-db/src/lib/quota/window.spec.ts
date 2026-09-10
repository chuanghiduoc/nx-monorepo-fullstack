import { describe, expect, it } from 'vitest';

import { LIFETIME_WINDOW_START, windowStart } from './window.js';

/**
 * Which window a moment belongs to.
 *
 * Pure, so this is the one part of quota with no database in it. It is also
 * the part where being wrong is quietest: a boundary computed two different
 * ways splits one window into two rows and hands out the whole limit twice,
 * and nothing anywhere reports it.
 */
describe('deciding which window a moment belongs to', () => {
  it('starts a daily window at midnight UTC', () => {
    expect(
      windowStart('daily', new Date('2026-09-03T13:45:12.345Z')).toISOString(),
    ).toBe('2026-09-03T00:00:00.000Z');
  });

  it('starts a monthly window on the first, at midnight UTC', () => {
    expect(
      windowStart('monthly', new Date('2026-09-30T23:59:59.999Z')).toISOString(),
    ).toBe('2026-09-01T00:00:00.000Z');
  });

  it('gives a lifetime entitlement one window, forever', () => {
    const early = windowStart('lifetime', new Date('2001-01-01T00:00:00.000Z'));
    const late = windowStart('lifetime', new Date('2099-12-31T23:59:59.999Z'));

    // A constant rather than "the beginning of this month, but never rolled
    // over": the column is part of a primary key and NOT NULL, so lifetime
    // needs *a* value, and the epoch is the one value that cannot be mistaken
    // for a real boundary somebody meant.
    expect(early.toISOString()).toBe(LIFETIME_WINDOW_START.toISOString());
    expect(late.toISOString()).toBe(early.toISOString());
  });

  it('is computed in UTC even when the machine is not', () => {
    // 2026-09-01T00:30:00Z is still 31 August in New York. A boundary taken
    // from the *server's* local clock would put this consume in August for a
    // machine in the Americas and September for one in Europe, so two replicas
    // of the same service would disagree about which window is being charged.
    const justAfterMidnightUtc = new Date('2026-09-01T00:30:00.000Z');

    expect(windowStart('monthly', justAfterMidnightUtc).toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
    expect(windowStart('daily', justAfterMidnightUtc).toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });

  it('rolls a daily window over at the boundary, not around it', () => {
    // `<` and `<=` questions have a way of being decided by accident. The last
    // millisecond of a day belongs to that day; the first of the next does not.
    expect(
      windowStart('daily', new Date('2026-09-03T23:59:59.999Z')).toISOString(),
    ).toBe('2026-09-03T00:00:00.000Z');
    expect(
      windowStart('daily', new Date('2026-09-04T00:00:00.000Z')).toISOString(),
    ).toBe('2026-09-04T00:00:00.000Z');
  });

  it('does not hand back the caller’s own Date', () => {
    const at = new Date('2026-09-03T13:45:12.345Z');
    const start = windowStart('daily', at);

    start.setUTCFullYear(1999);

    // Returning a mutated argument is the kind of thing that works until a
    // caller reuses the value it passed in.
    expect(at.toISOString()).toBe('2026-09-03T13:45:12.345Z');
  });
});
