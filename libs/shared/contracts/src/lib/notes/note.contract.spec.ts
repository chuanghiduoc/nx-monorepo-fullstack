import { describe, expect, it } from 'vitest';

import {
  CURSOR_MAX_LENGTH,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from '../pagination/page.js';
import {
  createNoteSchema,
  listNotesQuerySchema,
  noteSchema,
  notePageSchema,
  updateNoteSchema,
} from './note.contract.js';

/** Repeated here on purpose: a test that reads the constant it is checking
 * passes for any value of it. */
const TITLE_MAX = 200;
const BODY_MAX = 20_000;

/**
 * These rules reach two places at once: the service turns them into request
 * validation, and the browser turns them into a form resolver. The point of
 * the tests is that there is one answer to "is this acceptable", not two that
 * happen to agree today.
 */
describe('the note contract', () => {
  it('needs a title', () => {
    expect(createNoteSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('supplies an empty body when none is given', () => {
    const parsed = createNoteSchema.parse({ title: 'Something' });

    expect(parsed.body).toBe('');
  });

  it('refuses a title of nothing but spaces', () => {
    // `.min(1)` alone accepts it, and the row then renders as a blank line
    // nobody can identify or search for.
    expect(createNoteSchema.safeParse({ title: '   ' }).success).toBe(false);
  });

  it('accepts a title of exactly the length the column holds', () => {
    const exact = 'a'.repeat(TITLE_MAX);

    expect(createNoteSchema.safeParse({ title: exact }).success).toBe(true);
  });

  it('refuses a title one character longer than that', () => {
    const tooLong = 'a'.repeat(TITLE_MAX + 1);

    expect(createNoteSchema.safeParse({ title: tooLong }).success).toBe(false);
  });

  it('measures a title in characters, the way the column does', () => {
    // Emoji are two UTF-16 units each. Counting units rather than characters
    // would refuse a title Postgres stores without complaint.
    const emoji = '🙂'.repeat(TITLE_MAX);

    expect(emoji.length).toBe(TITLE_MAX * 2);
    expect(createNoteSchema.safeParse({ title: emoji }).success).toBe(true);
  });

  it('refuses a body longer than the contract allows', () => {
    const tooLong = 'a'.repeat(BODY_MAX + 1);

    expect(
      createNoteSchema.safeParse({ title: 'Fine', body: tooLong }).success,
    ).toBe(false);
  });

  it('demands the version an edit is replacing', () => {
    // Without it a second editor's change silently overwrites the first, and
    // nobody involved ever learns that it happened.
    expect(updateNoteSchema.safeParse({ title: 'Edited' }).success).toBe(false);
    expect(
      updateNoteSchema.safeParse({ title: 'Edited', version: 1 }).success,
    ).toBe(true);
  });

  it('refuses a version below the first one a note can have', () => {
    expect(updateNoteSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(updateNoteSchema.safeParse({ version: -1 }).success).toBe(false);
  });

  it('refuses a version that is not a whole number', () => {
    expect(updateNoteSchema.safeParse({ version: 1.5 }).success).toBe(false);
  });

  it('refuses an update that changes nothing', () => {
    // It would still raise the version and the timestamp, making every other
    // open editor stale for no change at all.
    expect(updateNoteSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  it('reads a page limit that arrived as a string', () => {
    // Query strings carry no types; the client sends `?limit=50`.
    const parsed = listNotesQuerySchema.parse({ limit: '50' });

    expect(parsed.limit).toBe(50);
  });

  it('supplies the default page size when none is asked for', () => {
    // Published as a default so a generated client reads it from the document
    // rather than assuming a number.
    expect(listNotesQuerySchema.parse({}).limit).toBe(DEFAULT_PAGE_LIMIT);
  });

  it('refuses a limit that is not a number at all', () => {
    for (const limit of ['fifty', '1.5', 'null']) {
      expect(listNotesQuerySchema.safeParse({ limit }).success).toBe(false);
    }
  });

  it('refuses a limit below one', () => {
    expect(listNotesQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('accepts the largest page the service will serve', () => {
    expect(
      listNotesQuerySchema.parse({ limit: String(MAX_PAGE_LIMIT) }).limit,
    ).toBe(MAX_PAGE_LIMIT);
  });

  it('refuses a page larger than the service will serve', () => {
    const parsed = listNotesQuerySchema.safeParse({
      limit: String(MAX_PAGE_LIMIT + 1),
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses a cursor long enough to be an attack', () => {
    const oversized = 'a'.repeat(CURSOR_MAX_LENGTH + 1);

    expect(listNotesQuerySchema.safeParse({ cursor: oversized }).success).toBe(
      false,
    );
  });

  it('says a page is the last one with null, not a separate flag', () => {
    const page = notePageSchema.parse({ items: [], nextCursor: null });

    expect(page.nextCursor).toBeNull();
  });

  it('refuses a page whose rows are malformed', () => {
    // The wrapper must validate what it wraps; a page that accepted anything
    // would make the row schema decorative.
    const bad = notePageSchema.safeParse({
      items: [{ id: 'not-a-uuid', title: 'x' }],
      nextCursor: null,
    });

    expect(bad.success).toBe(false);
  });

  it('refuses an identifier that is not the version the database generates', () => {
    // A v4 identifier is random, so it carries no time ordering — and the
    // cursor relies on that ordering to break ties between equal timestamps.
    const v4 = '9f1b7a5e-3c2d-4a6b-8e1f-2b3c4d5e6f70';
    const row = {
      id: v4,
      title: 'x',
      body: '',
      version: 1,
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    };

    expect(noteSchema.safeParse(row).success).toBe(false);
  });
});
