import { describe, expect, it } from 'vitest';

import {
  FALLBACK_LOCALE,
  LOCALES,
  isLocale,
  resolveDefaultLocale,
} from './locales.js';

describe('locales', () => {
  it('offers the languages the application is written in', () => {
    expect([...LOCALES].sort()).toEqual(['en', 'vi']);
  });

  it('has a fallback that is one of them', () => {
    expect(LOCALES).toContain(FALLBACK_LOCALE);
  });

  it('takes a deployment at its word when it names a language there are messages for', () => {
    expect(resolveDefaultLocale('en')).toBe('en');
  });

  it('falls back rather than shipping a page of dotted keys', () => {
    // An unknown value is a misconfiguration; rendering every string as its
    // own key would look like a broken layout instead.
    expect(resolveDefaultLocale('klingon')).toBe(FALLBACK_LOCALE);
    expect(resolveDefaultLocale(undefined)).toBe(FALLBACK_LOCALE);
    expect(resolveDefaultLocale('')).toBe(FALLBACK_LOCALE);
  });

  it('accepts only a language there are messages for', () => {
    expect(isLocale('vi')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('klingon')).toBe(false);
    expect(isLocale('')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
