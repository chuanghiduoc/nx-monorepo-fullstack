import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const MAX_TITLE = 255;
const MAX_SOURCE = 1_024;
const MAX_QUESTION = 2_000;

/**
 * How much text one ingest may carry.
 *
 * A bound rather than none, because every character becomes a passage and
 * every passage becomes a request to an embedding provider — an unbounded
 * ingest is an unbounded bill, and the caller who sends it will not be the one
 * who notices.
 */
const MAX_TEXT = 200_000;

const ingestSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE),
  /** A URL, a file name, whatever the caller knows. Shown with an answer. */
  source: z.string().max(MAX_SOURCE).optional(),
  text: z.string().min(1).max(MAX_TEXT),
});

export class IngestDocumentDto extends createZodDto(ingestSchema) {}

const documentSchema = z.object({
  id: z.uuidv7(),
  title: z.string().max(MAX_TITLE),
  source: z
    .string()
    .max(MAX_SOURCE)
    .nullable()
    .describe('Where it came from; null when the caller did not say.'),
  chunkCount: z
    .number()
    .int()
    .nonnegative()
    .describe('How many passages the document was cut into.'),
  createdAt: z.iso.datetime(),
});

export class AiDocumentDto extends createZodDto(documentSchema) {}

const documentListSchema = z.object({ items: z.array(documentSchema) });

export class AiDocumentListDto extends createZodDto(documentListSchema) {}

const askSchema = z.object({
  question: z.string().min(1).max(MAX_QUESTION),
});

export class AskQueryDto extends createZodDto(askSchema) {}
