import { useTranslations } from 'next-intl';
import { Suspense } from 'react';

import { AuthShell } from '../../../components/auth-shell';
import { SignInForm } from './sign-in-form';

export default function SignInPage() {
  const t = useTranslations('auth.signIn');

  return (
    <AuthShell description={t('subtitle')} title={t('title')}>
      {/* The form reads the `next` query parameter, and a component that reads
          the URL cannot be prerendered. Keeping the boundary here lets the
          frame around it stay static. */}
      <Suspense>
        <SignInForm />
      </Suspense>
    </AuthShell>
  );
}
