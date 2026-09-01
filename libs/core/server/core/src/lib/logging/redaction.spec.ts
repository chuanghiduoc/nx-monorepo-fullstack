import { describe, expect, it } from 'vitest';
import pino from 'pino';

import { REDACTED_PATHS, REDACTION_CENSOR } from './redaction.js';

/**
 * Redaction is only worth having if it survives a refactor, so this test drives
 * a real pino instance and reads what it wrote — not what the config says.
 */
function logAndCapture(payload: unknown): string {
  let written = '';

  const logger = pino(
    { redact: { paths: [...REDACTED_PATHS], censor: REDACTION_CENSOR } },
    { write: (line: string) => (written += line) } as never,
  );

  logger.info(payload as never);
  return written;
}

describe('log redaction', () => {
  it('removes the authorization header', () => {
    const written = logAndCapture({
      req: { headers: { authorization: 'Bearer super-secret-token' } },
    });

    expect(written).not.toContain('super-secret-token');
    expect(written).toContain(REDACTION_CENSOR);
  });

  it('removes cookies, which carry the session', () => {
    const written = logAndCapture({
      req: { headers: { cookie: 'better-auth.session_token=abc123' } },
    });

    expect(written).not.toContain('abc123');
  });

  it('removes api keys', () => {
    const written = logAndCapture({
      req: { headers: { 'x-api-key': 'live_key_value' } },
    });

    expect(written).not.toContain('live_key_value');
  });

  it('removes set-cookie from responses', () => {
    const written = logAndCapture({
      res: { headers: { 'set-cookie': 'session=issued-token' } },
    });

    expect(written).not.toContain('issued-token');
  });

  it('keeps everything that is not a secret', () => {
    const written = logAndCapture({
      req: { headers: { 'user-agent': 'vitest' }, url: '/api/v1/items' },
    });

    expect(written).toContain('/api/v1/items');
    expect(written).toContain('vitest');
  });
});
