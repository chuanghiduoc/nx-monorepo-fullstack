import { z } from 'zod';

import { defineEvent } from './event.contract.js';

const AGGREGATE = 'note';

/**
 * What every note event carries.
 *
 * Metadata, and **not the note's text**. A payload sits in `outbox_events` for
 * the retention window and an audit consumer copies it into records kept
 * longer still, so putting the content here would mean that for a week after
 * somebody deletes a note its full text survives in tables no erasure
 * procedure knows about — and forever in one that failed. A consumer that
 * needs the content reads the aggregate, which is also the only version of it
 * that is still true.
 *
 * The lengths are here because they are what an audit trail actually wants to
 * show — that something was written, and roughly how much — without becoming a
 * copy of it.
 */
const noteEvent = z.object({
  noteId: z.uuidv7(),
  orgId: z.uuidv7(),
  /** The aggregate's optimistic-concurrency version after the change. */
  version: z.number().int().nonnegative(),
  titleLength: z.number().int().nonnegative(),
  bodyLength: z.number().int().nonnegative(),
});

export const noteCreated = defineEvent({
  type: 'note.created',
  aggregate: AGGREGATE,
  payload: noteEvent,
});

export const noteUpdated = defineEvent({
  type: 'note.updated',
  aggregate: AGGREGATE,
  payload: noteEvent,
});

/**
 * A note that no longer exists.
 *
 * The same shape as the other two rather than a smaller one: a consumer
 * handling all three switches on the type, and a payload that changes shape
 * per type turns that into three parsers. `version` is the version it had when
 * it was removed, and the lengths are what it contained — the last chance to
 * record that, since the row is gone.
 */
export const noteDeleted = defineEvent({
  type: 'note.deleted',
  aggregate: AGGREGATE,
  payload: noteEvent,
});
