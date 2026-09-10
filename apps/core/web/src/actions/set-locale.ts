'use server';

import { cookies } from 'next/headers';

import { LOCALE_COOKIE, isLocale, type Locale } from '@workspace/shared-i18n';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Remembers the reader's language.
 *
 * A server action rather than an API route: the choice is a cookie and a
 * re-render, and nothing about it needs to be a public endpoint.
 */
export async function setLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale)) {
    // A value from outside the known set would leave the application with no
    // messages at all, so it is refused rather than stored.
    throw new Error(`Unknown locale: ${locale}`);
  }

  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    maxAge: ONE_YEAR_SECONDS,
    sameSite: 'lax',
    path: '/',
  });
}
