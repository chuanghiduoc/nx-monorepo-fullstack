import { describe, expect, it } from 'vitest';

import { noteCreated, noteDeleted, noteUpdated } from './note.events.js';

const ORG = '0199a1b2-0000-7000-8000-00000000000a';
const NOTE = '0199a1b2-0000-7000-8000-0000000000cc';

const valid = {
  noteId: NOTE,
  orgId: ORG,
  version: 1,
  titleLength: 12,
  bodyLength: 340,
};

const all = [noteCreated, noteUpdated, noteDeleted];

describe('the note events', () => {
  it('name the aggregate and the tense, and the names are what is stored', () => {
    // Stored verbatim, so a consumer built from a different deploy matches on
    // the string rather than on the identity of an object.
    expect(all.map((event) => event.type)).toEqual([
      'note.created',
      'note.updated',
      'note.deleted',
    ]);
    expect(new Set(all.map((event) => event.aggregate))).toEqual(
      new Set(['note']),
    );
  });

  it('carry the tenant, so a consumer can open a transaction at all', () => {
    // Without it the worker has no tenant to scope its reads to, and a job
    // that reads nothing looks exactly like a bug in the query.
    for (const event of all) {
      expect(event.payload.safeParse({ ...valid, orgId: undefined }).success).toBe(
        false,
      );
    }
  });

  it('refuse a payload carrying the note itself', () => {
    // The rule this file exists to hold. A payload sits in the outbox for a
    // week and an audit consumer copies it somewhere kept longer, so content
    // in an event is content that outlives its deletion in tables no erasure
    // procedure knows about. Lengths, not text.
    for (const event of all) {
      const withContent = event.payload.safeParse({
        ...valid,
        title: 'A title',
        body: 'Everything the person wrote.',
      });

      expect(withContent.success).toBe(true);
      expect(withContent.success && withContent.data).toEqual(valid);
    }
  });

  it('accept what a producer actually has to hand', () => {
    for (const event of all) {
      expect(event.payload.parse(valid)).toEqual(valid);
    }
  });

  it('refuse an id that is not one of ours', () => {
    // uuidv7 rather than uuid: every id in this schema is time-ordered, and a
    // v4 here means somebody generated it somewhere it should not have been.
    expect(
      noteCreated.payload.safeParse({
        ...valid,
        noteId: '9f1c0e2e-1f4a-4c3e-8a1e-2b7d5c6f8a90',
      }).success,
    ).toBe(false);
  });
});
