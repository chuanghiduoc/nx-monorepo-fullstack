'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import type { FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';

type Translate = ReturnType<typeof useTranslations<'validation'>>;
type Issue = z.core.$ZodRawIssue;

/**
 * Turns a schema issue into a sentence in the reader's language.
 *
 * The schemas themselves carry no messages, and should not: they are shared
 * with the service, which answers machines. Left to their defaults, the
 * primary language of this product would show English — "Too small: expected
 * string to have >=8 characters" — beside fully translated labels.
 *
 * Only the codes these forms can produce are handled. Returning nothing for
 * anything else falls back to the library's own wording, which is at least
 * accurate.
 */
function messageFor(issue: Issue, t: Translate): string | undefined {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? t('required') : t('invalid');

    case 'too_small':
      // A minimum of one character is "you have to fill this in", which is a
      // different sentence from "this is too short".
      return Number(issue.minimum) === 1
        ? t('required')
        : t('tooSmall', { minimum: Number(issue.minimum) });

    case 'too_big':
      return t('tooBig', { maximum: Number(issue.maximum) });

    case 'invalid_format':
      return issue.format === 'email' ? t('email') : t('pattern');

    default:
      return undefined;
  }
}

/**
 * A form resolver that reports in the reader's language.
 *
 * Every form uses this rather than `zodResolver` directly, so the rules stay
 * in the shared contracts and the wording stays in the catalogue.
 */
export function useFormResolver<Input extends FieldValues, Output>(
  schema: z.ZodType<Output, Input>,
): Resolver<Input, unknown, Output> {
  const t = useTranslations('validation');

  return zodResolver<Input, unknown, Output>(schema, {
    error: (issue: Issue) => messageFor(issue, t),
  });
}
