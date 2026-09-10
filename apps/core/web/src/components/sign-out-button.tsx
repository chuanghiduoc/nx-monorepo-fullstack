'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { authClient } from '../lib/auth-client';

export function SignOutButton() {
  const t = useTranslations('auth');
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  function signOut() {
    setFailed(false);

    startTransition(async () => {
      const { error } = await authClient.signOut();

      if (error) {
        // Navigating anyway would show the sign-in page to somebody whose
        // session is still live. On a shared machine that is the whole
        // failure: they walk away believing they are out.
        setFailed(true);
        return;
      }

      // Replace, not push: the back button must not return to a page that
      // renders as though the session were still there.
      router.replace('/sign-in');
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={signOut}
        className="text-sm text-neutral-500 hover:underline disabled:opacity-50"
      >
        {t('signOut')}
      </button>
      {failed ? (
        <span role="alert" className="text-sm text-red-600">
          {t('signOutFailed')}
        </span>
      ) : null}
    </div>
  );
}
