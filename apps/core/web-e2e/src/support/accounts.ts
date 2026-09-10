import { randomUUID } from 'node:crypto';

import { expect, type Page } from '@playwright/test';

/**
 * The origin the tests address.
 *
 * Cookies are set against this rather than a constant, so pointing `BASE_URL`
 * at a deployed application does not silently stop the language cookie from
 * being sent — which would fail every language test for a reason no message
 * would reveal.
 */
export const WEB_ORIGIN = process.env['BASE_URL'] ?? 'http://localhost:4200';

export interface Account {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

/**
 * A fresh account for one test.
 *
 * Every test makes its own rather than sharing a fixture: these run in
 * parallel against one database, and a shared account would make them race
 * over the same rows and the same active organization.
 */
export function newAccount(): Account {
  // A random identifier rather than a counter and a clock. The counter starts
  // again in every worker and every browser project, so two of them entering
  // the same millisecond mint the same address — and the second sign-up fails
  // on a unique constraint that has nothing to do with what is being tested.
  return {
    email: `web-e2e-${randomUUID()}@example.com`,
    password: 'a-long-enough-password',
    name: 'Web Test User',
  };
}

/** A slug unique to one test and legal for the contract to accept. */
export function newSlug(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Fixes the language before anything renders.
 *
 * The application reads a cookie rather than a path segment, so a test that
 * navigates first and sets the cookie afterwards asserts against the previous
 * language. Setting it on the context means the very first request carries it.
 */
export async function useLanguage(page: Page, locale: 'en' | 'vi'): Promise<void> {
  await setLanguageCookie(page, locale);
}

/**
 * Sets the cookie to any value at all, including one no application offers.
 *
 * Separate from `useLanguage` so that helper stays honest about what it
 * accepts, and the one test that needs an unknown value says so.
 */
export async function setLanguageCookie(
  page: Page,
  locale: string,
): Promise<void> {
  await page.context().addCookies([
    { name: 'locale', value: locale, url: WEB_ORIGIN },
  ]);
}

/**
 * Types into a field and proves it kept what was typed.
 *
 * A page is interactive before it is hydrated: the markup arrives first and
 * the framework attaches to it a moment later, and anything typed in between
 * can be discarded when it does. The retry is not a workaround for a slow
 * machine, it is the only way to know the value survived.
 */
export async function fillField(
  page: Page,
  label: string,
  value: string,
): Promise<void> {
  const field = page.getByLabel(label, { exact: true });

  await expect(async () => {
    await field.fill(value);
    await expect(field).toHaveValue(value, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** Signs up through the form, ending on the notes page. */
export async function signUp(page: Page, account: Account): Promise<void> {
  await page.goto('/sign-up');
  await fillField(page, 'Name', account.name);
  await fillField(page, 'Email', account.email);
  await fillField(page, 'Password', account.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/notes');
}

/** Creates an organization and leaves the session acting inside it. */
/** Long enough for a create, a session switch and a re-render. */
const SWITCHED_TIMEOUT_MS = 20_000;

export async function createOrganization(
  page: Page,
  name: string,
  slug: string,
): Promise<void> {
  await page.goto('/settings/organizations');
  await fillField(page, 'Name', name);
  await fillField(page, 'Identifier', slug);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  // Waiting for the switcher to *show it as selected* waits for the write and
  // for the session to be acting inside it. Waiting merely for the name to
  // appear in the list would pass while the request still carried the previous
  // organization, and the test after it would be racing.
  //
  // A longer timeout than the default, and it is not papering over anything:
  // this waits on three round trips — the create, the session being switched to
  // it, and the re-render — where the five-second default is sized for one.
  // Measured as a flake: Firefox, inside a full `pnpm verify` with every other
  // suite competing for the machine, showed the previous organization still
  // selected at five seconds and the right one shortly after.
  await expect(
    page.getByRole('combobox', { name: 'Organizations' }).locator('option:checked'),
  ).toHaveText(name, { timeout: SWITCHED_TIMEOUT_MS });
}
