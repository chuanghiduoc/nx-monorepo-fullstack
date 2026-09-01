import { describe, expect, it } from 'vitest';

import {
  CURSOR_MAX_LENGTH,
  decodeCursor,
  encodeCursor,
  hashPaginationFilter,
  resolvePageLimit,
} from './cursor.js';

const filterHash = hashPaginationFilter({ sort: 'createdAt:desc' });

const payload = {
  sortKey: '2026-09-02T10:00:00.000Z',
  id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  filterHash,
  direction: 'forward',
} as const;

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a payload', () => {
    expect(decodeCursor(encodeCursor(payload), filterHash)).toEqual(payload);
  });

  it('produces an opaque value', () => {
    const cursor = encodeCursor(payload);

    // base64url only, and none of the field names leak through.
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain('sortKey');
    expect(cursor).not.toContain(payload.id);
  });

  it('rejects a cursor produced under a different filter', () => {
    const cursor = encodeCursor(payload);
    const otherFilter = hashPaginationFilter({ sort: 'createdAt:asc' });

    // Reusing a cursor across filters silently skips or repeats rows, so it is
    // the client's mistake to hear about, not something to paper over.
    expect(() => decodeCursor(cursor, otherFilter)).toThrowError(/cursor/i);
  });

  it.each([
    ['not base64url at all', 'not a cursor!!'],
    ['base64url that is not JSON', Buffer.from('nonsense').toString('base64url')],
    [
      'JSON of the wrong shape',
      Buffer.from(JSON.stringify({ nope: true })).toString('base64url'),
    ],
    [
      'a sort key that is not a timestamp',
      Buffer.from(
        JSON.stringify({ ...payload, sortKey: 'yesterday' }),
      ).toString('base64url'),
    ],
    [
      'an id that is not a uuid',
      Buffer.from(JSON.stringify({ ...payload, id: '1' })).toString('base64url'),
    ],
    [
      'an unknown direction',
      Buffer.from(JSON.stringify({ ...payload, direction: 'sideways' })).toString(
        'base64url',
      ),
    ],
    ['an empty string', ''],
  ])('rejects %s', (_case, cursor) => {
    expect(() => decodeCursor(cursor, filterHash)).toThrowError(/cursor/i);
  });

  it('rejects an oversized cursor without parsing it', () => {
    const oversized = 'a'.repeat(CURSOR_MAX_LENGTH + 1);

    expect(() => decodeCursor(oversized, filterHash)).toThrowError(/cursor/i);
  });

  it('round-trips a backward cursor', () => {
    const backward = { ...payload, direction: 'backward' } as const;

    expect(decodeCursor(encodeCursor(backward), filterHash)).toEqual(backward);
  });
});

describe('hashPaginationFilter', () => {
  it('does not depend on key order', () => {
    expect(hashPaginationFilter({ a: 1, b: 2 })).toBe(
      hashPaginationFilter({ b: 2, a: 1 }),
    );
  });

  it('changes when a filter value changes', () => {
    expect(hashPaginationFilter({ status: 'open' })).not.toBe(
      hashPaginationFilter({ status: 'closed' }),
    );
  });

  it('treats an absent filter and an explicitly undefined one as the same query', () => {
    expect(hashPaginationFilter({ status: undefined })).toBe(
      hashPaginationFilter({}),
    );
  });
});

describe('resolvePageLimit', () => {
  it.each([
    [undefined, 20],
    [1, 1],
    [50, 50],
    [100, 100],
  ])('accepts %s', (requested, expected) => {
    expect(resolvePageLimit(requested)).toBe(expected);
  });

  it.each([0, -1, 101, 10_000, Number.NaN, 1.5])(
    'rejects %s rather than silently clamping',
    (requested) => {
      // Silently clamping means a caller asking for 10 000 rows gets 100 and
      // believes it has the whole set.
      expect(() => resolvePageLimit(requested)).toThrowError(/limit/i);
    },
  );
});
