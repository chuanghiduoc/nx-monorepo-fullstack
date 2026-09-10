'use client';

import { ThemeToggle } from '@workspace/shared-ui';
import { useTranslations } from 'next-intl';

/**
 * The design system's toggle, with this application's words.
 *
 * The component knows the three states and the icon for each; only the labels
 * are the product's, and they belong in the catalogue like every other string
 * somebody reads.
 */
export function ThemeToggleButton() {
  const t = useTranslations('theme');

  return (
    <ThemeToggle
      labels={{ light: t('light'), dark: t('dark'), system: t('system') }}
    />
  );
}
