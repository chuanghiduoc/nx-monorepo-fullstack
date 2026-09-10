import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * What a person is told when they ask to be forgotten.
 *
 * The date matters more than the acknowledgement: it is the deadline for
 * changing their mind, and a response that only said "accepted" would leave
 * them to guess it.
 */
const erasureRequestedSchema = z.object({
  erasureRequestedAt: z.iso.datetime(),
  /** When the data is actually removed, if nothing cancels it first. */
  erasesAt: z.iso.datetime(),
  graceDays: z.number().int().positive(),
});

export class ErasureRequestedDto extends createZodDto(erasureRequestedSchema) {}

const erasureStatusSchema = z.object({
  /** Null when this account is not scheduled for erasure. */
  erasureRequestedAt: z.iso.datetime().nullable(),
  erasesAt: z.iso.datetime().nullable(),
});

export class ErasureStatusDto extends createZodDto(erasureStatusSchema) {}
