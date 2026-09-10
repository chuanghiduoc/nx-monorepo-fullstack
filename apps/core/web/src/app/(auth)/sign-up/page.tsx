import { useTranslations } from 'next-intl';

import { AuthShell } from '../../../components/auth-shell';
import { SignUpForm } from './sign-up-form';

export default function SignUpPage() {
  const t = useTranslations('auth.signUp');

  return (
    <AuthShell description={t('subtitle')} title={t('title')}>
      <SignUpForm />
    </AuthShell>
  );
}
