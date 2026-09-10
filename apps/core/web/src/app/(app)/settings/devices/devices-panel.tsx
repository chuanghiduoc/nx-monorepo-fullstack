'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { authClient } from '../../../../lib/auth-client';
import { useSession } from '../../../../lib/use-session';

/** What this page needs from a session, and nothing more. */
interface DeviceSession {
  readonly id: string;
  readonly token: string;
  readonly userAgent?: string | null;
  readonly ipAddress?: string | null;
  readonly createdAt: Date | string;
}

type Failure = 'load' | 'revoke';

/**
 * Every session this account has open, and a way to end one.
 *
 * Revoking is by session token rather than by device name: two browsers
 * reporting the same user agent are two sessions, and ending "the Chrome one"
 * would be ambiguous in exactly the situation where somebody is trying to lock
 * an intruder out.
 */
export function DevicesPanel() {
  const t = useTranslations('devices');
  const format = useFormatter();
  const router = useRouter();
  const { data: current } = useSession();
  const [sessions, setSessions] = useState<DeviceSession[] | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [busy, setBusy] = useState<string | undefined>();

  const load = useCallback(async () => {
    const { data, error } = await authClient.listSessions();

    if (error) {
      setFailure('load');
      setSessions([]);
      return;
    }

    setFailure(undefined);
    setSessions((data ?? []) as DeviceSession[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(token: string) {
    setFailure(undefined);
    setBusy(token);

    try {
      const { error } = await authClient.revokeSession({ token });

      if (error) {
        // Reloading the list here would show the row still present with no
        // explanation, which reads as the button doing nothing.
        setFailure('revoke');
        return;
      }

      if (token === current?.session.token) {
        // Ending your own session leaves nothing to come back to.
        router.replace('/sign-in');
        router.refresh();
        return;
      }

      await load();
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>

      {failure ? (
        <p role="alert" className="text-red-600">
          {failure === 'load' ? t('failed') : t('revokeFailed')}
        </p>
      ) : null}

      {sessions === undefined ? (
        <p className="text-neutral-500">{t('loading')}</p>
      ) : null}

      {sessions?.length === 0 && failure !== 'load' ? (
        <p className="text-neutral-500">{t('empty')}</p>
      ) : null}

      <ul className="space-y-2">
        {sessions?.map((session) => {
          const device = session.userAgent || t('unknown');

          return (
            <li
              key={session.id}
              className="flex items-center justify-between gap-4 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
            >
              <div>
                <p className="text-sm">{device}</p>
                <p className="text-sm text-neutral-500">
                  {format.dateTime(new Date(session.createdAt), 'medium')}
                  {session.ipAddress ? ` · ${session.ipAddress}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {session.token === current?.session.token ? (
                  <span className="text-sm text-neutral-500">
                    {t('current')}
                  </span>
                ) : null}
                <button
                  type="button"
                  // Named, because every button in this list would otherwise
                  // announce as "Revoke" and a screen reader gives no way to
                  // tell which row is about to end.
                  aria-label={t('revokeNamed', { device })}
                  onClick={() => revoke(session.token)}
                  disabled={busy !== undefined}
                  className="text-sm text-red-600 hover:underline disabled:opacity-50"
                >
                  {t('revoke')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
