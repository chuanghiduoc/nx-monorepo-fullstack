const DEFAULT_DESTINATION = '/notes';

/** Any origin will do; it only has to be one no real site can claim. */
const SENTINEL_ORIGIN = 'http://safe.invalid';

const LAST_CONTROL_CODE = 0x1f;
const DELETE_CODE = 0x7f;

/**
 * Tab, newline, carriage return and the rest of the C0 range.
 *
 * Written as a scan rather than a regular expression because a character class
 * over this range is exactly what the `no-control-regex` rule exists to catch,
 * and the rule is right in general.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    if (code <= LAST_CONTROL_CODE || code === DELETE_CODE) {
      return true;
    }
  }

  return false;
}

/**
 * Turns the `next` query parameter into somewhere safe to send the browser.
 *
 * Anything that is not a path on this site becomes the default. Without that
 * test, `?next=https://example.com` would make the sign-in page a redirector
 * carrying this site's name and reputation to wherever an attacker chose, and
 * the victim would arrive there having just typed their password.
 *
 * Two tests, because neither is enough on its own. The leading slash rejects a
 * scheme and a relative path — a relative path resolves against the sentinel
 * here and against the current page in the browser, so one string would mean
 * two destinations. Parsing then catches what no prefix test can: the URL
 * parser strips tab, newline and carriage return from anywhere in a string
 * *before* it parses, so `/%0A/example.com` begins with a single slash, passes
 * any such test, and still resolves to another origin.
 */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || hasControlCharacter(value)) {
    return DEFAULT_DESTINATION;
  }

  let resolved: URL;
  try {
    resolved = new URL(value, SENTINEL_ORIGIN);
  } catch {
    // A string the parser refuses is not a destination.
    return DEFAULT_DESTINATION;
  }

  if (resolved.origin !== SENTINEL_ORIGIN) {
    return DEFAULT_DESTINATION;
  }

  return `${resolved.pathname}${resolved.search}`;
}
