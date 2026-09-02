import { CURSOR_MAX_LENGTH, MAX_PAGE_LIMIT } from '@workspace/core-server-core';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const MAX_TITLE = 200;
const MAX_BODY = 20_000;

const createNoteSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE),
  body: z.string().max(MAX_BODY).default(''),
});

const updateNoteSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE).optional(),
  body: z.string().max(MAX_BODY).optional(),
  /**
   * The version the client read. Required, not optional: an update that does
   * not say what it is replacing cannot be checked for a lost write, and
   * making it optional would make the safe path the one you opt into.
   */
  version: z.number().int().min(1),
});

const noteSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const notePageSchema = z.object({
  items: z.array(noteSchema),
  /** `null` means there is nothing after this page — no separate flag. */
  nextCursor: z.string().max(CURSOR_MAX_LENGTH).nullable(),
});

const listNotesQuerySchema = z.object({
  cursor: z.string().max(CURSOR_MAX_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
});

export class CreateNoteDto extends createZodDto(createNoteSchema) {}
export class UpdateNoteDto extends createZodDto(updateNoteSchema) {}
export class NoteDto extends createZodDto(noteSchema) {}
export class NotePageDto extends createZodDto(notePageSchema) {}
export class ListNotesQueryDto extends createZodDto(listNotesQuerySchema) {}
