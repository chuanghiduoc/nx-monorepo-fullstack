'use client';

import { ThemeProvider as NextThemeProvider } from 'next-themes';

/**
 * Carries the reader's choice of light, dark or "follow the system".
 *
 * `attribute="class"` because the design system states its dark palette under
 * a `.dark` class; without it every `dark:` utility in the application is
 * unreachable and a reader on a dark system gets the light theme.
 *
 * `disableTransitionOnChange` stops every coloured surface animating at once
 * when the theme flips, which reads as a glitch rather than a transition.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemeProvider>
  );
}
