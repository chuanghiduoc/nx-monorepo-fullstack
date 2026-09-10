import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { workspaceRoot } from '@nx/devkit';
import { expect, test } from '@playwright/test';

import { setLanguageCookie, useLanguage } from './support/accounts';

/**
 * Read from disk rather than imported.
 *
 * The catalogue belongs to the application, and a suite may not import another
 * project's source — that rule is what keeps the dependency graph honest. This
 * suite already starts that application's built artifact and drives it, so
 * reading one of its files is the coupling it already has, stated plainly.
 */
const messages: Record<string, unknown> = JSON.parse(
  readFileSync(
    join(workspaceRoot, 'apps', 'core', 'web', 'messages', 'en.json'),
    'utf8',
  ),
);

/**
 * The application in both languages.
 *
 * The check that matters is not that a heading is translated but that nothing
 * is missing: an absent key renders as its own dotted path, which reads like a
 * layout bug and reaches production because nobody was looking for it.
 *
 * The pattern is built from the catalogue rather than written out, so a
 * namespace added tomorrow is covered without anyone remembering a list here.
 */
const MISSING_KEY = new RegExp(
  `\\b(${Object.keys(messages).join('|')})\\.[a-zA-Z.]+\\b`,
);

test.describe('language', () => {
  test('opens in Vietnamese by default', async ({ page }) => {
    await page.goto('/sign-in');

    await expect(
      page.getByRole('heading', { name: 'Đăng nhập' }),
    ).toBeVisible();
  });

  test('switches to English and stays there', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Ngôn ngữ').selectOption('en');

    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // A cookie, so the choice survives a fresh page load rather than living in
    // the tab that made it.
    await page.goto('/sign-up');
    await expect(
      page.getByRole('heading', { name: 'Create an account' }),
    ).toBeVisible();
  });

  for (const [locale, signIn, signUp] of [
    ['vi', 'Đăng nhập', 'Tạo tài khoản'],
    ['en', 'Sign in', 'Create an account'],
  ] as const) {
    test(`renders every string on the sign-in page in ${locale}`, async ({
      page,
    }) => {
      await useLanguage(page, locale);
      await page.goto('/sign-in');

      await expect(page.getByRole('heading', { name: signIn })).toBeVisible();

      const text = await page.locator('body').innerText();
      expect(text).not.toMatch(MISSING_KEY);
    });

    test(`renders every string on the sign-up page in ${locale}`, async ({
      page,
    }) => {
      await useLanguage(page, locale);
      await page.goto('/sign-up');

      // Asserted, not assumed: without it the English run passes against a
      // page rendered entirely in Vietnamese.
      await expect(page.getByRole('heading', { name: signUp })).toBeVisible();

      const text = await page.locator('body').innerText();
      expect(text).not.toMatch(MISSING_KEY);
    });
  }

  test('falls back to the default when the cookie says something unknown', async ({
    page,
  }) => {
    await setLanguageCookie(page, 'klingon');

    await page.goto('/sign-in');

    // Not a crash and not an untranslated page: an unknown language is the
    // default one.
    await expect(
      page.getByRole('heading', { name: 'Đăng nhập' }),
    ).toBeVisible();
  });
});
