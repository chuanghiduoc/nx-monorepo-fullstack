import { Toaster } from '@workspace/shared-ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

import { ImpersonationBanner } from '../../components/impersonation-banner';
import { OrganizationSwitcher } from '../../components/organization-switcher';
import { QueryProvider } from '../../components/query-provider';
import { SignOutButton } from '../../components/sign-out-button';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations();

  return (
    <QueryProvider>
      <ImpersonationBanner />
      <header className="flex flex-wrap items-center gap-4 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <nav className="flex gap-4 text-sm">
          <Link href="/notes" className="hover:underline">
            {t('notes.title')}
          </Link>
          <Link href="/settings/organizations" className="hover:underline">
            {t('organizations.title')}
          </Link>
          <Link href="/settings/devices" className="hover:underline">
            {t('devices.title')}
          </Link>
          <Link href="/settings/security" className="hover:underline">
            {t('security.title')}
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <OrganizationSwitcher />
          <SignOutButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl p-6">{children}</main>
      {/* Where an action that failed says so. A form's own errors stay beside
          the field they belong to; this is for the ones with nowhere else to
          go — a revoke that was refused, a switch that did not happen. */}
      <Toaster />
    </QueryProvider>
  );
}
