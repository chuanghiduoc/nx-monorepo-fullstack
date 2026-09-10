export const LOCALES = ['vi', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * Narrows an arbitrary string to a language the application has messages for.
 *
 * Anything else is treated as absent. A locale nobody translated would render
 * every string as its own dotted key, which reads as a broken layout rather
 * than a missing translation.
 */
export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (LOCALES as readonly string[]).includes(value);
}

/**
 * The language to fall back to when nothing else has been decided.
 *
 * Which language a *deployment* leads with is that deployment's decision, and
 * it reads it from its own environment — this library states only the last
 * resort. Reading configuration here would make the shared vocabulary depend
 * on a Node global that does not exist in a browser bundle.
 */
export const FALLBACK_LOCALE: Locale = 'vi';

/**
 * Narrows a configured value to a language there are messages for, falling
 * back when it is absent or unknown.
 */
export function resolveDefaultLocale(configured: string | undefined): Locale {
  return isLocale(configured) ? configured : FALLBACK_LOCALE;
}

/**
 * Where the reader's choice is kept.
 *
 * A cookie rather than a path segment, so there is one set of routes instead
 * of one per language and no link has to decide which it belongs to. That
 * suits an application behind a sign-in; a public site being indexed would
 * want the opposite.
 */
export const LOCALE_COOKIE = 'locale';
