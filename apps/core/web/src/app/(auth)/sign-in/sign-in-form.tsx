'use client';

import { signInSchema, type SignIn } from '@workspace/shared-contracts';
import { Button, Field, FieldError, FieldLabel, Input } from '@workspace/shared-ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { PasswordField } from '../../../components/password-field';
import { authClient } from '../../../lib/auth-client';
import { useFormResolver } from '../../../lib/use-form-resolver';
import { safeNext } from '../../../lib/safe-next';

export function SignInForm() {
  const t = useTranslations('auth.signIn');
  const router = useRouter();
  const destination = safeNext(useSearchParams().get('next'));
  const [failed, setFailed] = useState(false);

  const form = useForm<SignIn>({
    resolver: useFormResolver(signInSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: SignIn) {
    setFailed(false);

    const { data, error } = await authClient.signIn.email(values);

    if (error) {
      // One message for a wrong password and an unknown address alike:
      // distinguishing them tells an attacker which addresses are registered.
      setFailed(true);
      return;
    }

    if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) {
      // The password was right but it is not enough on its own. No session
      // cookie exists yet; the second factor is what creates one.
      router.push(`/two-factor?next=${encodeURIComponent(destination)}`);
      return;
    }

    router.push(destination);
    router.refresh();
  }

  return (
    <form
      className="w-full space-y-4 pt-6"
      noValidate
      onSubmit={form.handleSubmit(onSubmit)}
    >
      <Field data-invalid={Boolean(form.formState.errors.email) || undefined}>
        <FieldLabel htmlFor="email">{t('email')}</FieldLabel>
        <Input
          aria-invalid={Boolean(form.formState.errors.email)}
          autoComplete="email"
          id="email"
          placeholder="you@company.com"
          type="email"
          {...form.register('email')}
        />
        <FieldError errors={[form.formState.errors.email]} />
      </Field>

      <Field data-invalid={Boolean(form.formState.errors.password) || undefined}>
        <FieldLabel htmlFor="password">{t('password')}</FieldLabel>
        <PasswordField
          aria-invalid={Boolean(form.formState.errors.password)}
          autoComplete="current-password"
          id="password"
          {...form.register('password')}
        />
        <FieldError errors={[form.formState.errors.password]} />
      </Field>

      {failed ? (
        <p
          className="rounded-xl bg-destructive/10 px-3 py-2 text-destructive text-sm"
          role="alert"
        >
          {t('failed')}
        </p>
      ) : null}

      <Button className="w-full" disabled={form.formState.isSubmitting} type="submit">
        {form.formState.isSubmitting ? t('submitting') : t('submit')}
      </Button>

      <p className="text-center text-muted-foreground text-sm">
        {t('noAccount')}{' '}
        <Link
          className="font-bold text-brand underline-offset-4 hover:underline"
          href="/sign-up"
        >
          {t('signUpLink')}
        </Link>
      </p>
    </form>
  );
}
