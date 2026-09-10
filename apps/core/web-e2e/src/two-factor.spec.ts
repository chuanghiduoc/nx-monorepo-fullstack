import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import { expect, test } from '@playwright/test';

import { fillField, newAccount, signUp, useLanguage } from './support/accounts';

/**
 * Reads the shared secret out of the address the enrolment screen shows.
 *
 * An authenticator address carries the secret base32-encoded, which is what
 * every authenticator application expects; the code generator wants the bytes
 * back. Handing it the encoded form produces six digits that look right and
 * are always rejected.
 */
function secretFrom(totpUri: string): string {
  const encoded = new URL(totpUri).searchParams.get('secret');

  if (!encoded) {
    throw new Error(`No secret in the enrolment address: ${totpUri}`);
  }

  return new TextDecoder().decode(base32.decode(encoded));
}

/** The code an authenticator would show for that secret right now. */
function currentCode(secret: string): Promise<string> {
  // The same library the service verifies with, so this proves the two agree
  // rather than proving a reimplementation agrees with itself.
  return createOTP(secret).totp();
}

test.describe('the second factor', () => {
  test.beforeEach(async ({ page }) => {
    await useLanguage(page, 'en');
  });

  test('is turned on, and then required to sign in', async ({ page }) => {
    const account = newAccount();
    await signUp(page, account);

    await page.goto('/settings/security');
    await expect(page.getByTestId('two-factor-state')).toHaveText(
      'Two-factor authentication is off.',
    );

    await fillField(page, 'Confirm your password', account.password);
    await page
      .getByRole('button', { name: 'Turn on two-factor authentication' })
      .click();

    const secret = secretFrom(await page.getByTestId('totp-uri').innerText());
    expect(secret.length).toBeGreaterThan(0);

    // Nothing is on until a code from the new device comes back and matches.
    await expect(page.getByTestId('two-factor-state')).toHaveText(
      'Two-factor authentication is off.',
    );
    await fillField(page, 'Code from the application', await currentCode(secret));
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByTestId('two-factor-state')).toHaveText(
      'Two-factor authentication is on.',
    );

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/sign-in**');

    // The password alone now gets as far as the code screen and no further.
    await page.goto('/sign-in');
    await fillField(page, 'Email', account.email);
    await fillField(page, 'Password', account.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/two-factor**');

    // Generated immediately before it is submitted: a code produced earlier
    // can cross a window boundary while a form is being filled in.
    await fillField(page, 'Code', await currentCode(secret));
    await page.getByRole('button', { name: 'Confirm' }).click();

    await page.waitForURL('**/notes');
    await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  });

  test('refuses a code that is not the current one', async ({ page }) => {
    const account = newAccount();
    await signUp(page, account);

    await page.goto('/settings/security');
    await fillField(page, 'Confirm your password', account.password);
    await page
      .getByRole('button', { name: 'Turn on two-factor authentication' })
      .click();
    const secret = secretFrom(await page.getByTestId('totp-uri').innerText());
    await fillField(page, 'Code from the application', await currentCode(secret));
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByTestId('two-factor-state')).toHaveText(
      'Two-factor authentication is on.',
    );

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/sign-in**');

    await page.goto('/sign-in');
    await fillField(page, 'Email', account.email);
    await fillField(page, 'Password', account.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/two-factor**');

    await fillField(page, 'Code', '000000');
    await page.getByRole('button', { name: 'Confirm' }).click();

    await expect(
      page.getByText('That code is wrong or has expired.'),
    ).toBeVisible();
    // Still on the code screen: a wrong code creates no session.
    await expect(page).toHaveURL(/\/two-factor/);
  });

  test('will not be turned on by a session that cannot supply the password', async ({
    page,
  }) => {
    const account = newAccount();
    await signUp(page, account);

    await page.goto('/settings/security');
    await fillField(page, 'Confirm your password', 'not-the-password');
    await page
      .getByRole('button', { name: 'Turn on two-factor authentication' })
      .click();

    // An open session is not enough to enrol a device its owner never sees.
    await expect(
      page.getByText('That did not work. Check the password and try again.'),
    ).toBeVisible();
    await expect(page.getByTestId('totp-uri')).toHaveCount(0);
  });
});

test.describe('enrolment that is never confirmed', () => {
  test('leaves the account signing in with a password alone', async ({
    page,
  }) => {
    await useLanguage(page, 'en');
    const account = newAccount();
    await signUp(page, account);

    await page.goto('/settings/security');
    await fillField(page, 'Confirm your password', account.password);
    await page
      .getByRole('button', { name: 'Turn on two-factor authentication' })
      .click();
    await page.getByTestId('totp-uri').waitFor();

    // Walking away here is the case that would lock someone out if enrolling
    // were one step: the secret exists, but nothing has proved it reached a
    // device the person still has.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/sign-in**');

    await fillField(page, 'Email', account.email);
    await fillField(page, 'Password', account.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The claim is that the code screen never appears, which is a stronger
    // statement than "it eventually reached the notes page".
    await page.waitForURL('**/notes');
    await expect(page).not.toHaveURL(/\/two-factor/);
    await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  });
});
