import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** How many event names one subscriber may filter on. */
const MAX_NAMES = 32;
const MAX_NAME_LENGTH = 64;

const streamQuerySchema = z.object({
  /**
   * Which events to send, comma separated. Absent means all of them.
   *
   * A filter, never a permission: what a subscriber may see is decided by the
   * room, which comes from the session. Narrowing here saves bytes on the wire
   * and nothing else — asking for an event another organization's stream
   * carries still delivers nothing.
   */
  names: z
    .string()
    .max(MAX_NAMES * (MAX_NAME_LENGTH + 1))
    .optional()
    .describe('Comma-separated event names; absent means every event.'),
});

export class StreamQueryDto extends createZodDto(streamQuerySchema) {}

/** The names a query asked for, cleaned up and bounded. */
export function namesFrom(query: { names?: string }): string[] {
  return (query.names ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.length <= MAX_NAME_LENGTH)
    .slice(0, MAX_NAMES);
}
