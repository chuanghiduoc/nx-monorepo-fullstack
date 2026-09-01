import { createHash } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

import { canonicalJson } from '../serialisation/canonical-json.js';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/**
 * A cursor never needs to be long. Capping the length means a hostile client
 * cannot make us base64-decode and JSON-parse megabytes per request.
 */
export const CURSOR_MAX_LENGTH = 512;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

const cursorSchema = z.object({
  /** Value of the sort column on the last row of the previous page. */
  sortKey: z.iso.datetime(),
  /** UUIDv7 tie-breaker: sort keys are not unique, primary keys are. */
  id: z.uuid(),
  /** Identifies the query the cursor was produced under. */
  filterHash: z.string().min(1),
  direction: z.enum(['forward', 'backward']),
});

export type CursorPayload = z.infer<typeof cursorSchema>;

/**
 * Identifies the filter and sort a cursor belongs to.
 *
 * Keyset pagination is only correct while the query stays the same. Changing a
 * filter between pages and keeping the cursor silently skips or repeats rows,
 * which is the kind of bug that shows up as "the report is missing an order"
 * weeks later — so the query is fingerprinted into the cursor and checked on
 * the way back in.
 */
export function hashPaginationFilter(filter: unknown): string {
  return createHash('sha256').update(canonicalJson(filter)).digest('hex').slice(0, 16);
}

/**
 * Opaque by construction: clients must treat the cursor as a token to hand
 * back, not as a value to build. Encoding the keyset position in the URL as
 * readable fields would make it part of the public contract, and we could
 * never change the sort.
 */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, expectedFilterHash: string): CursorPayload {
  if (cursor.length === 0 || cursor.length > CURSOR_MAX_LENGTH || !BASE64URL.test(cursor)) {
    throw invalidCursor();
  }

  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw invalidCursor();
  }

  const result = cursorSchema.safeParse(parsed);
  if (!result.success) {
    throw invalidCursor();
  }

  if (result.data.filterHash !== expectedFilterHash) {
    throw new BadRequestException(
      'The cursor belongs to a different query. Start again without a cursor after changing filters or sorting.',
    );
  }

  return result.data;
}

/**
 * Rejects rather than clamps: a caller that asks for 10 000 rows and silently
 * receives 100 believes it has the whole set.
 */
export function resolvePageLimit(requested?: number): number {
  if (requested === undefined) {
    return DEFAULT_PAGE_LIMIT;
  }

  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_PAGE_LIMIT) {
    throw new BadRequestException(
      `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`,
    );
  }

  return requested;
}

function invalidCursor(): BadRequestException {
  // Deliberately says nothing about why: the cursor is opaque, so "your JSON is
  // malformed" would only be useful to someone forging one.
  return new BadRequestException('The cursor is not valid.');
}
