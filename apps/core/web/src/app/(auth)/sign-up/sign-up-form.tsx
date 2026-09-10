'use client';

import { signUpSchema, type SignUp } from '@workspace/shared-contracts';
import { Button, Field, FieldError, FieldLabel, Input } from '@workspace/shared-ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { PasswordField } from '../../../components/password-field';
import { authClient } from '../../../lib/auth-client';
import { useFormResolver } from '../../../lib/use-form-resolver';

export function SignUpForm() {
  const t = useTranslations('auth.signUp');
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  const form = useForm<SignUp>({
    resolver: useFormResolver(signUpSchema),
    defaultValues: { name: '', email: '', password: '' },
  });

  async function onSubmit(values: SignUp) {
    setFailed(false);

    const { error } = await authClient.signUp.email(values);

    if (error) {
      // Including "that address is taken", which is why the message says only
      // that it did not work: confirming an address exists is an enumeration
      // oracle for anyone who wants a list of the site's members.
      setFailed(true);
      return;
    }

    router.push('/notes');
    router.refresh();
  }

  return (
    <form
      className="w-full space-y-4 pt-6"
      noValidate
      onSubmit={form.handleSubmit(onSubmit)}
    >
      <Field data-invalid={Boolean(form.formState.errors.name) || undefined}>
        <FieldLabel htmlFor="name">{t('name')}</FieldLabel>
        <Input
          aria-invalid={Boolean(form.formState.errors.name)}
          autoComplete="name"
          id="name"
          {...form.register('name')}
        />
        <FieldError errors={[form.formState.errors.name]} />
      </Field>

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
          autoComplete="new-password"
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
        {t('hasAccount')}{' '}
        <Link
          className="font-bold text-brand underline-offset-4 hover:underline"
          href="/sign-in"
        >
          {t('signInLink')}
        </Link>
      </p>
    </form>
  );
}
