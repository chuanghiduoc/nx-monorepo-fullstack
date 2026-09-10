'use client';

import { LOCALES, type Locale } from '@workspace/shared-i18n';
import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { setLocale } from '../actions/set-locale';

const LABELS: Record<Locale, string> = {
  vi: 'Tiếng Việt',
  en: 'English',
};

export function LocaleSwitcher() {
  const t = useTranslations('common');
  const current = useLocale();
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  function choose(locale: Locale) {
    setFailed(false);
    // The callback is async and awaited inside the transition, so `pending`
    // covers the round trip. A synchronous callback that dropped the promise
    // would finish the transition immediately — leaving the control enabled
    // and any rejection unhandled.
    startTransition(async () => {
      try {
        await setLocale(locale);
      } catch {
        setFailed(true);
      }
    });
  }

  return (
    <div className="fixed bottom-4 right-4 flex items-center gap-2 rounded-lg border border-neutral-200 bg-white/90 px-3 py-2 text-sm shadow-sm backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/90">
      <label htmlFor="locale" className="text-neutral-500">
        {t('language')}
      </label>
      <select
        id="locale"
        value={current}
        disabled={pending}
        onChange={(event) => choose(event.target.value as Locale)}
        className="bg-transparent outline-none disabled:opacity-50"
      >
        {LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {LABELS[locale]}
          </option>
        ))}
      </select>
      {failed ? (
        <span role="alert" className="text-red-600">
          {t('error')}
        </span>
      ) : null}
    </div>
  );
}
