import { expect, test } from '@playwright/test';

import { useLanguage } from './support/accounts';

test.describe('the front page', () => {
  test.beforeEach(async ({ page }) => {
    await useLanguage(page, 'en');
  });

  test('names the application and offers the way in', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('app-heading')).toHaveText('Platform');
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('styles its controls from the shared design system', async ({ page }) => {
    await page.goto('/sign-in');

    // Not merely that the component rendered: these utility classes only
    // exist in the stylesheet if Tailwind picked up the library's sources,
    // which it does through an `@source` line that is easy to lose.
    const submit = page.getByRole('button', { name: 'Sign in' });

    await expect(submit).toBeVisible();
    await expect(submit).toHaveClass(/inline-flex/);
    await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute(
      'data-slot',
      'input',
    );
  });
});
