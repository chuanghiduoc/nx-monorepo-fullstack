import { describe, expect, it } from 'vitest';

import { fingerprintRequest, normaliseRoute } from './request-fingerprint.js';

describe('normaliseRoute', () => {
  it('combines method and path so one key cannot span two routes', () => {
    expect(normaliseRoute('post', '/api/v1/demo-items')).toBe(
      'POST:/api/v1/demo-items',
    );
  });

  it('drops the query string, which does not identify the route', () => {
    expect(normaliseRoute('POST', '/api/v1/demo-items?draft=true')).toBe(
      'POST:/api/v1/demo-items',
    );
  });

  it('ignores a trailing slash', () => {
    expect(normaliseRoute('POST', '/api/v1/demo-items/')).toBe(
      'POST:/api/v1/demo-items',
    );
  });
});

describe('fingerprintRequest', () => {
  it('is stable for the same request', () => {
    const first = fingerprintRequest('POST', '/api/v1/items', { title: 'a' });
    const second = fingerprintRequest('POST', '/api/v1/items', { title: 'a' });

    expect(first).toBe(second);
  });

  it('ignores key order, which carries no meaning in JSON', () => {
    const a = fingerprintRequest('POST', '/api/v1/items', { x: 1, y: 2 });
    const b = fingerprintRequest('POST', '/api/v1/items', { y: 2, x: 1 });

    expect(a).toBe(b);
  });

  it('changes when the body changes', () => {
    const a = fingerprintRequest('POST', '/api/v1/items', { title: 'a' });
    const b = fingerprintRequest('POST', '/api/v1/items', { title: 'b' });

    expect(a).not.toBe(b);
  });

  it('changes when the route changes', () => {
    const a = fingerprintRequest('POST', '/api/v1/items', { title: 'a' });
    const b = fingerprintRequest('POST', '/api/v1/other', { title: 'a' });

    expect(a).not.toBe(b);
  });

  it('changes when the method changes', () => {
    const a = fingerprintRequest('POST', '/api/v1/items', {});
    const b = fingerprintRequest('PUT', '/api/v1/items', {});

    expect(a).not.toBe(b);
  });
});
