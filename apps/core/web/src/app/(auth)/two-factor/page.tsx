import { useTranslations } from 'next-intl';
import { Suspense } from 'react';

import { AuthShell } from '../../../components/auth-shell';
import { TwoFactorForm } from './two-factor-form';

export default function TwoFactorPage() {
  const t = useTranslations('auth.twoFactor');

  return (
    <AuthShell description={t('hint')} title={t('title')}>
      <Suspense>
        <TwoFactorForm />
      </Suspense>
    </AuthShell>
  );
}
