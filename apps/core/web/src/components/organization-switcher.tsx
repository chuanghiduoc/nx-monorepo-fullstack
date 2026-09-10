'use client';

import { useTranslations } from 'next-intl';

import { authClient } from '../lib/auth-client';
import { useSession } from '../lib/use-session';
import { useSwitchOrganization } from '../lib/use-switch-organization';

/**
 * Changes which organization the session is acting in.
 *
 * The active organization is held on the session, not in the browser: every
 * API request derives its tenant from it, and a value kept client-side would
 * be a claim the caller makes about itself.
 */
export function OrganizationSwitcher() {
  const t = useTranslations('organizations');
  const { data: session } = useSession();
  const {
    data: organizations,
    isPending,
    error,
  } = authClient.useListOrganizations();
  const { switchTo, switching } = useSwitchOrganization();

  // Three states, three answers. Collapsing them would tell somebody whose
  // API is down that they belong to no organization, which is a false claim
  // about their account rather than a report of a failure.
  if (isPending) {
    return <span className="text-sm text-neutral-500">{t('loading')}</span>;
  }

  if (error) {
    return (
      <span role="alert" className="text-sm text-red-600">
        {t('loadFailed')}
      </span>
    );
  }

  if (!organizations || organizations.length === 0) {
    return <span className="text-sm text-neutral-500">{t('none')}</span>;
  }

  const active = session?.session.activeOrganizationId ?? '';

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-neutral-500">{t('current')}</span>
      <select
        aria-label={t('title')}
        value={active}
        disabled={switching}
        onChange={(event) => switchTo(event.target.value)}
        className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 disabled:opacity-50 dark:border-neutral-700"
      >
        {active === '' ? <option value="">{t('choose')}</option> : null}
        {organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name}
          </option>
        ))}
      </select>
    </label>
  );
}
