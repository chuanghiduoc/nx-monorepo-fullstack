'use client';

import { Input, cn } from '@workspace/shared-ui';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

/**
 * A password box that can be read back.
 *
 * Hiding what somebody types is a defence against the person behind them, and
 * a cause of the typo they cannot see. Offering both is why every browser now
 * ships this control; `aria-pressed` is what tells a screen reader which state
 * it is in.
 */
export function PasswordField({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Input>, 'type'>) {
  const t = useTranslations('auth');
  const [visible, setVisible] = useState(false);

  const Icon = visible ? EyeOff : Eye;

  return (
    <div className="relative">
      <Input
        className={cn('pr-10', className)}
        type={visible ? 'text' : 'password'}
        {...props}
      />
      <button
        aria-label={visible ? t('hidePassword') : t('showPassword')}
        aria-pressed={visible}
        className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setVisible((current) => !current)}
        type="button"
      >
        <Icon className="size-4" />
      </button>
    </div>
  );
}
