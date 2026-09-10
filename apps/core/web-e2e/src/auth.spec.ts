import { expect, test } from '@playwright/test';

import {
  WEB_ORIGIN,
  createOrganization,
  fillField,
  newAccount,
  newSlug,
  signUp,
  useLanguage,
} from './support/accounts';

/**
 * The signed-in surface, through a browser.
 *
 * These exercise what nothing below them can: that a session cookie survives
 * the hop from the web origin to the API origin, that the tenant a request
 * acts in follows from the organization the person chose, and that a signed
 * out visitor cannot reach the application by typing its address.
 */
test.describe('signing in and working', () => {
  test.beforeEach(async ({ page }) => {
    await useLanguage(page, 'en');
  });

  test('sends a signed-out visitor to sign in, and back where they were going', async ({
    page,
  }) => {
    await page.goto('/settings/devices');

    await expect(page).toHaveURL(/\/sign-in\?next=%2Fsettings%2Fdevices$/);
    await expect(
      page.getByRole('heading', { name: 'Sign in' }),
    ).toBeVisible();
  });

  test('refuses to be turned into a redirector for another site', async ({
    page,
  }) => {
    const account = newAccount();
    await signUp(page, account);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/sign-in**');

    await page.goto('/sign-in?next=https://example.com/steal');
    await fillField(page, 'Email', account.email);
    await fillField(page, 'Password', account.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Where it lands is the point: this site, whatever the parameter said.
    await page.waitForURL('**/notes');
    expect(new URL(page.url()).origin).toBe(WEB_ORIGIN);
  });

  test('creates an account, an organization, and a note in it', async ({
    page,
  }) => {
    const account = newAccount();
    await signUp(page, account);

    // No organization yet: the notes page explains rather than erroring.
    await page.goto('/notes');
    await expect(
      page.getByText('Choose an organization before viewing notes.'),
    ).toBeVisible();

    await createOrganization(page, 'First Company', newSlug('first'));

    await page.goto('/notes');
    await fillField(page, 'Title', 'A note in the first company');
    await fillField(page, 'Body', 'Body text');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('A note in the first company')).toBeVisible();
  });

  test('shows only the notes of the organization being worked in', async ({
    page,
  }) => {
    await signUp(page, newAccount());

    await createOrganization(page, 'Alpha', newSlug('alpha'));
    await page.goto('/notes');
    await fillField(page, 'Title', 'Alpha note');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Alpha note')).toBeVisible();

    await createOrganization(page, 'Beta', newSlug('beta'));
    await page.goto('/notes');

    // Not a filter the page remembered to apply: the request carries the
    // organization, and the database refuses to return anything else.
    await expect(page.getByText('No notes yet.')).toBeVisible();
    await expect(page.getByText('Alpha note')).toHaveCount(0);
  });

  test('deletes a note', async ({ page }) => {
    await signUp(page, newAccount());
    await createOrganization(page, 'Deleting', newSlug('deleting'));

    await page.goto('/notes');
    await fillField(page, 'Title', 'Temporary');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Temporary')).toBeVisible();

    await page.getByRole('button', { name: 'Delete note' }).click();

    await expect(page.getByText('No notes yet.')).toBeVisible();
  });

  test('lists the session it is running in, and signs out', async ({ page }) => {
    await signUp(page, newAccount());

    await page.goto('/settings/devices');
    await expect(page.getByText('This session')).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/sign-in**');

    // The session is gone, not merely navigated away from.
    await page.goto('/notes');
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('refuses a password that is too short, before asking the server', async ({
    page,
  }) => {
    await page.goto('/sign-up');
    await fillField(page, 'Name', 'Someone');
    await fillField(page, 'Email', 'someone@example.com');
    await fillField(page, 'Password', 'short');
    await page.getByRole('button', { name: 'Create account' }).click();

    // Still on the form: the same rule the service enforces, applied here so
    // the person is not told after submitting.
    await expect(page).toHaveURL(/\/sign-up/);
  });
});
