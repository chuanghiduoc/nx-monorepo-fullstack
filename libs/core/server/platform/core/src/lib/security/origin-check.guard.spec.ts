import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { OriginCheckGuard } from './origin-check.guard.js';

const ALLOWED = ['http://localhost:4200', 'https://app.example.com'];

function contextFor(request: {
  method: string;
  headers: Record<string, string | undefined>;
}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('OriginCheckGuard', () => {
  const guard = new OriginCheckGuard(ALLOWED);

  it('allows a state-changing request from an allowed origin', () => {
    const context = contextFor({
      method: 'POST',
      headers: { origin: 'http://localhost:4200' },
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a state-changing request from a foreign origin', () => {
    const context = contextFor({
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('rejects PATCH and DELETE from a foreign origin as well', () => {
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const context = contextFor({
        method,
        headers: { origin: 'https://evil.example.com' },
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    }
  });

  it('never blocks a safe method, whatever the origin', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const context = contextFor({
        method,
        headers: { origin: 'https://evil.example.com' },
      });

      expect(guard.canActivate(context)).toBe(true);
    }
  });

  it('allows a request with no origin when it carries an api key', () => {
    // Server-to-server callers send no Origin. They authenticate with a key,
    // which a browser cannot attach on a cross-site request.
    const context = contextFor({
      method: 'POST',
      headers: { 'x-api-key': 'live_key_value' },
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a state-changing request with neither origin nor api key', () => {
    const context = contextFor({ method: 'POST', headers: {} });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
