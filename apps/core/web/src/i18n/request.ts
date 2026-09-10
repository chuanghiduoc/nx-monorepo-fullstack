import {
  LOCALE_COOKIE,
  isLocale,
  resolveDefaultLocale,
} from '@workspace/shared-i18n';
import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

/**
 * Named date and time formats.
 *
 * There are no built-in ones. Asking for a name that was never defined does
 * not throw — the value falls back to `String(date)`, so a session list shows
 * `Thu Sep 02 2026 14:03:11 GMT+0700 (Indochina Time)` in every language, and
 * nothing anywhere reports a problem.
 */
const formats = {
  dateTime: {
    medium: { dateStyle: 'medium', timeStyle: 'short' },
    short: { dateStyle: 'short' },
  },
} as const;

/** Which language this deployment leads with, before anyone has chosen. */
const defaultLocale = resolveDefaultLocale(
  process.env['NEXT_PUBLIC_DEFAULT_LOCALE'],
);

/**
 * The locale comes from a cookie, not from the URL.
 *
 * URL-based locales would put a prefix on every route and turn every link
 * into a decision. A cookie keeps one set of paths, which matters more here
 * than a shareable localised URL: this is an application behind a sign-in,
 * not a public site being indexed.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const requested = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(requested) ? requested : defaultLocale;

  return {
    locale,
    formats,
    // Stated rather than inherited: without it the server formats in the
    // machine's zone and the browser in the reader's, and the same timestamp
    // renders differently on either side of hydration.
    timeZone: process.env['APP_TIME_ZONE'] ?? 'Asia/Ho_Chi_Minh',
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
