'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { authClient } from '../lib/auth-client';
import { useSession } from '../lib/use-session';

/**
 * Says out loud that an administrator is acting as somebody else.
 *
 * Impersonation without a visible marker is indistinguishable from a session
 * hijack, both to the person watching a screen share and to whoever reads the
 * audit log afterwards. The banner is not decoration: it is the difference
 * between a supported operation and one nobody can account for.
 */
export function ImpersonationBanner() {
  const t = useTranslations('impersonation');
  const router = useRouter();
  const { data } = useSession();
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!data?.session.impersonatedBy) {
    return null;
  }

  function stop() {
    setFailed(false);

    startTransition(async () => {
      const { error } = await authClient.admin.stopImpersonating();

      if (error) {
        // The one place silence is least acceptable: leaving quietly would
        // tell an administrator they are themselves again while every action
        // they take is still recorded against somebody else.
        setFailed(true);
        return;
      }

      router.push('/notes');
      router.refresh();
    });
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-4 bg-amber-400 px-4 py-2 text-sm text-amber-950"
    >
      <span>{t('banner', { name: data.user.name || data.user.email })}</span>
      <div className="flex items-center gap-3">
        {failed ? (
          <span role="alert" className="font-medium">
            {t('stopFailed')}
          </span>
        ) : null}
        <button
          type="button"
          onClick={stop}
          disabled={pending}
          className="rounded-md border border-amber-950/40 px-2 py-1 font-medium disabled:opacity-50"
        >
          {t('stop')}
        </button>
      </div>
    </div>
  );
}
