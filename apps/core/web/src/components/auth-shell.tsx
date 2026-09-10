import { Card } from '@workspace/shared-ui';
import Image from 'next/image';

import { LocaleSwitcher } from './locale-switcher';
import { ThemeToggleButton } from './theme-toggle-button';

const AUTH_BACKGROUND = '/brand/auth-background.png';
const LOGO = '/brand/logo-horizontal.png';

/**
 * The frame every credential screen sits in.
 *
 * One component rather than a layout file, because each screen supplies its
 * own title, description and footer — a layout can wrap them but cannot be
 * told what they are.
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div
      className="relative flex min-h-svh flex-col items-start justify-center bg-brand-dark bg-cover bg-center bg-no-repeat px-4"
      style={{ backgroundImage: `url(${AUTH_BACKGROUND})` }}
    >
      <div className="absolute top-4 right-4 flex items-center gap-2 text-white">
        <LocaleSwitcher />
        <ThemeToggleButton />
      </div>

      <div className="container mx-auto flex w-full items-start justify-start lg:pl-16">
        <Card className="w-full min-w-[320px] max-w-[450px] gap-0 rounded-2xl px-6 pt-4 pb-6 shadow-2xl sm:px-8 sm:pt-5 sm:pb-8 md:min-w-[400px]">
          <div className="flex flex-col items-center gap-3 text-center">
            <Image
              alt=""
              // Decorative: the name is in the heading below, so announcing
              // the logo as well would read it twice.
              className="h-16 w-auto shrink-0 object-contain dark:rounded-lg dark:bg-white dark:px-3 dark:py-1"
              height={52}
              priority
              src={LOGO}
              width={200}
            />
            <div className="space-y-1">
              <h1 className="font-bold text-brand text-sm uppercase tracking-wide">
                {title}
              </h1>
              <p className="text-muted-foreground text-sm">{description}</p>
            </div>
          </div>

          {children}

          {footer ? (
            <p className="mt-6 text-center text-muted-foreground text-sm">
              {footer}
            </p>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
