import {
  createNoteSchema,
  listNotesQuerySchema,
  noteSchema,
  notePageSchema,
  updateNoteSchema,
} from '@workspace/shared-contracts';
import { createZodDto } from 'nestjs-zod';

/**
 * The request and response classes, wrapped around the shared definitions.
 *
 * Nothing is described here that the browser does not also read: a rule stated
 * once cannot disagree with itself, and a form built from the same schema
 * rejects exactly what this route would have rejected.
 */
export class CreateNoteDto extends createZodDto(createNoteSchema) {}
export class UpdateNoteDto extends createZodDto(updateNoteSchema) {}
export class NoteDto extends createZodDto(noteSchema) {}
export class NotePageDto extends createZodDto(notePageSchema) {}
export class ListNotesQueryDto extends createZodDto(listNotesQuerySchema) {}
