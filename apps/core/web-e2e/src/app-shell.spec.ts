import { test, expect } from '@playwright/test';

test.describe('core-web shell', () => {
  test('renders the application heading', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('app-heading')).toHaveText('core-web');
  });

  test('renders a component from the shared design system', async ({ page }) => {
    await page.goto('/');

    const button = page.getByRole('button', { name: 'Shared design system' });

    await expect(button).toBeVisible();
    // Proves Tailwind processed the design-system sources, not just that the
    // component rendered: the utility classes only exist if @source picked the
    // library up.
    await expect(button).toHaveClass(/inline-flex/);
  });
});
