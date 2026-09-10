import { z } from 'zod';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/**
 * A cursor never needs to be long. Capping the length means a hostile client
 * cannot make the service base64-decode and JSON-parse megabytes per request.
 */
export const CURSOR_MAX_LENGTH = 512;

/**
 * A page size, however it arrived.
 *
 * A query string carries no types, so this is a string over HTTP and a number
 * when a test calls in directly; coercing takes both and publishes one integer
 * either way. The coercion is a little wider than the published type — `0x10`
 * arrives as 16 — but every such value still has to be a whole number inside
 * the range, so the widest thing it buys a caller is an odd way to spell a
 * number the service would have accepted anyway.
 */
const pageLimit = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_LIMIT)
  .default(DEFAULT_PAGE_LIMIT);

/** The query parameters every listing endpoint accepts. */
export const pageQuerySchema = z.object({
  /** Opaque; produced by a previous page and handed back unchanged. */
  cursor: z.string().max(CURSOR_MAX_LENGTH).optional(),
  // Stated with its default, so the published description names the page size
  // and a generated client does not have to guess it.
  limit: pageLimit,
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

/**
 * Wraps a row schema into a page of them.
 *
 * `nextCursor` carries the length bound for a second reason beyond safety: a
 * bare nullable string is published as two types at once, which the document
 * generator flattens into an array. The bound makes it publish a choice
 * between a string and null instead, which is what it means.
 */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    /** `null` means there is nothing after this page — no separate flag. */
    nextCursor: z.string().max(CURSOR_MAX_LENGTH).nullable(),
  });
}
