import { describe, expect, it } from 'vitest';

import { safeNext } from './safe-next';

describe('safeNext', () => {
  it('keeps a path on this site', () => {
    expect(safeNext('/settings/devices')).toBe('/settings/devices');
  });

  it('keeps the query string with it', () => {
    expect(safeNext('/notes?limit=3')).toBe('/notes?limit=3');
  });

  it('drops a fragment, which the server never sees anyway', () => {
    expect(safeNext('/notes#section')).toBe('/notes');
  });

  it('falls back when nothing was asked for', () => {
    expect(safeNext(null)).toBe('/notes');
    expect(safeNext(undefined)).toBe('/notes');
    expect(safeNext('')).toBe('/notes');
  });

  it('refuses another origin', () => {
    expect(safeNext('https://example.com/steal')).toBe('/notes');
    expect(safeNext('http://example.com')).toBe('/notes');
  });

  it('refuses a protocol-relative address', () => {
    // The browser reads `//example.com` as a full URL, which is the same
    // attack as the line above with the scheme left off.
    expect(safeNext('//example.com/steal')).toBe('/notes');
  });

  it('refuses a control character the URL parser would strip', () => {
    // This is the case a prefix test cannot catch. The parser removes tab,
    // newline and carriage return from anywhere in the string *before* it
    // parses, so each of these begins with one slash and still resolves to
    // another origin.
    expect(safeNext('/\n/example.com')).toBe('/notes');
    expect(safeNext('/\t/example.com')).toBe('/notes');
    expect(safeNext('/\r/example.com')).toBe('/notes');
    expect(safeNext('/\u0000/example.com')).toBe('/notes');
  });

  it('refuses a scheme that is not a page at all', () => {
    expect(safeNext('javascript:alert(1)')).toBe('/notes');
    expect(safeNext('data:text/html,<script>alert(1)</script>')).toBe('/notes');
  });

  it('refuses a path that does not start at the root', () => {
    // A relative path resolves against the sentinel here and against the
    // current page in the browser, so one string would mean two destinations.
    expect(safeNext('notes')).toBe('/notes');
    expect(safeNext('../settings')).toBe('/notes');
  });

  it('never returns anything that leaves this origin', () => {
    // A property rather than a case: whatever comes back is resolved again,
    // and it must land where it started.
    const hostile = [
      '//example.com',
      '/\n/example.com',
      'https://example.com',
      '/\\example.com',
      '/%2F%2Fexample.com',
      '\\\\example.com',
      'https:example.com',
    ];

    for (const value of hostile) {
      const result = safeNext(value);
      expect(new URL(result, 'https://app.example').origin).toBe(
        'https://app.example',
      );
    }
  });
});
