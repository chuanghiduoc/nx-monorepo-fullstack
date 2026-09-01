/**
 * Fields that must never reach a log aggregator.
 *
 * Kept separate from the module so the list can be asserted against a real
 * logger rather than inspected by eye.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
] as const;

export const REDACTION_CENSOR = '[redacted]';
