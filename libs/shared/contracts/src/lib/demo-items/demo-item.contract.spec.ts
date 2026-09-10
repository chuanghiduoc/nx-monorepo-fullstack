import { describe, expect, it } from 'vitest';

import { CURSOR_MAX_LENGTH, MAX_PAGE_LIMIT } from '../pagination/page.js';
import {
  createDemoItemSchema,
  demoItemPageSchema,
  demoItemSchema,
  listDemoItemsQuerySchema,
} from './demo-item.contract.js';

/** Written out rather than imported: a test that reads the constant it is
 * checking passes for any value of it. */
const MAX_TITLE_LENGTH = 200;

const row = {
  id: '0199a1b2-0000-7000-8000-00000000000a',
  title: 'Something',
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

describe('the demo item contract', () => {
  it('needs a title', () => {
    expect(createDemoItemSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('refuses a title of nothing but spaces', () => {
    expect(createDemoItemSchema.safeParse({ title: '  ' }).success).toBe(false);
  });

  it('accepts a title of exactly the length the column holds', () => {
    const exact = 'a'.repeat(MAX_TITLE_LENGTH);

    expect(createDemoItemSchema.safeParse({ title: exact }).success).toBe(true);
  });

  it('refuses a title one character longer than that', () => {
    const tooLong = 'a'.repeat(MAX_TITLE_LENGTH + 1);

    expect(createDemoItemSchema.safeParse({ title: tooLong }).success).toBe(
      false,
    );
  });

  it('accepts the row shape the service returns', () => {
    expect(demoItemSchema.safeParse(row).success).toBe(true);
  });

  it('refuses a timestamp that is not an instant in UTC', () => {
    // The client parses these into dates; a local time with no offset would
    // be read differently on either side of the wire.
    const local = { ...row, createdAt: '2026-09-02 00:00:00' };

    expect(demoItemSchema.safeParse(local).success).toBe(false);
  });

  it('reads a page limit that arrived as a string', () => {
    expect(listDemoItemsQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('refuses a page larger than the service will serve', () => {
    const parsed = listDemoItemsQuerySchema.safeParse({
      limit: String(MAX_PAGE_LIMIT + 1),
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses a cursor long enough to be an attack', () => {
    const oversized = 'a'.repeat(CURSOR_MAX_LENGTH + 1);

    expect(
      listDemoItemsQuerySchema.safeParse({ cursor: oversized }).success,
    ).toBe(false);
  });

  it('says a page is the last one with null', () => {
    const page = demoItemPageSchema.parse({ items: [row], nextCursor: null });

    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
  });

  it('refuses a page whose rows are malformed', () => {
    const bad = demoItemPageSchema.safeParse({
      items: [{ id: 'not-a-uuid' }],
      nextCursor: null,
    });

    expect(bad.success).toBe(false);
  });
});
