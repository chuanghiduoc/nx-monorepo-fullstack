import { useTranslations } from 'next-intl';
import Link from 'next/link';

/**
 * The front door.
 *
 * Deliberately thin: everything this application does is behind a session, so
 * the only useful thing to offer somebody who is not signed in is the way in.
 */
export default function Home() {
  // `useTranslations` rather than the async server helper: it works on both
  // sides, so this page renders the same way under test as it does in the
  // application.
  const t = useTranslations('home');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1
        data-testid="app-heading"
        className="text-3xl font-bold tracking-tight"
      >
        {t('title')}
      </h1>
      <p className="max-w-prose text-center text-sm text-neutral-500">
        {t('description')}
      </p>
      <div className="flex gap-3">
        <Link
          href="/sign-in"
          className="rounded-md bg-neutral-900 px-4 py-2 text-white dark:bg-white dark:text-neutral-900"
        >
          {t('signIn')}
        </Link>
        <Link
          href="/sign-up"
          className="rounded-md border border-neutral-300 px-4 py-2 dark:border-neutral-700"
        >
          {t('signUp')}
        </Link>
      </div>
    </main>
  );
}
