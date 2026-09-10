import { z } from 'zod';

import { pageOf, pageQuerySchema } from '../pagination/page.js';

const MAX_TITLE = 200;
const MAX_BODY = 20_000;

/**
 * One definition of what a note is, for both sides of the wire.
 *
 * The service turns these into request classes and the browser turns them into
 * form resolvers. Written twice they would disagree the first time a limit
 * moved, and the disagreement would show up as a form that accepts what the
 * service then rejects.
 */
export const createNoteSchema = z.object({
  // Trimmed before it is measured: a title of spaces passes `.min(1)`
  // and renders as a row nobody can identify.
  title: z.string().trim().min(1).max(MAX_TITLE),
  body: z.string().max(MAX_BODY).default(''),
});

export const updateNoteSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE).optional(),
    body: z.string().max(MAX_BODY).optional(),
    /**
     * The version the client read. Required, not optional: an update that
     * does not say what it is replacing cannot be checked for a lost write,
     * and making it optional would make the safe path the one you opt into.
     */
    version: z.number().int().min(1),
  })
  // An update naming neither field still increments the version and the
  // timestamp, so it makes every other open editor stale for no change at
  // all — a client could spin that in a loop.
  .refine((update) => update.title !== undefined || update.body !== undefined);

export const noteSchema = z.object({
  // v7 specifically: the database generates them, and the pagination cursor
  // depends on their time ordering to break ties.
  id: z.uuidv7(),
  title: z.string(),
  body: z.string(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const notePageSchema = pageOf(noteSchema);

export const listNotesQuerySchema = pageQuerySchema;

/**
 * What a caller sends. `body` may be left out, and the schema supplies the
 * empty string — so the form is typed from the input side, where the field is
 * optional, and the service reads the output side, where it always exists.
 */
export type CreateNoteInput = z.input<typeof createNoteSchema>;
export type CreateNote = z.infer<typeof createNoteSchema>;
export type UpdateNote = z.infer<typeof updateNoteSchema>;
export type Note = z.infer<typeof noteSchema>;
export type NotePage = z.infer<typeof notePageSchema>;
