import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { OriginCheckGuard } from './origin-check.guard.js';
import { SIGNED_REQUEST } from './signed-request.decorator.js';

const ALLOWED = ['http://localhost:4200', 'https://app.example.com'];

/** A handler with no metadata on it, which is the ordinary case. */
function plainHandler(): void {
  // Nothing: the guard only ever reads metadata off it.
}

function contextFor(
  request: {
    method: string;
    headers: Record<string, string | undefined>;
  },
  handler: () => void = plainHandler,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => class Controller {},
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

  it('lets a signed route through with neither origin nor api key', () => {
    // A signed upload URL is reached by a server with no `Origin` at all, and
    // by a browser form from wherever the page happens to be. There is no
    // cookie for a cross-site page to borrow, so the check would refuse the
    // legitimate callers and stop nothing.
    const context = contextFor({ method: 'PUT', headers: {} }, signedHandler);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('lets a signed route through from an origin that is not allowed', () => {
    const context = contextFor(
      { method: 'POST', headers: { origin: 'https://somebodys-app.example' } },
      signedHandler,
    );

    expect(guard.canActivate(context)).toBe(true);
  });

  it('still refuses the same request without the marker', () => {
    // The negative control: what makes the two tests above prove anything is
    // that the identical request is refused when the route is not marked.
    expect(() =>
      guard.canActivate(contextFor({ method: 'PUT', headers: {} })),
    ).toThrow(ForbiddenException);
  });
});

/** A handler carrying the marker the decorator sets. */
function signedHandler(): void {
  // Nothing: the metadata below is the whole of it.
}

Reflect.defineMetadata(SIGNED_REQUEST, true, signedHandler);
