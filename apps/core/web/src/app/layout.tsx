import './global.css';
import { cn } from '@workspace/shared-ui';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import { Be_Vietnam_Pro } from 'next/font/google';

import { ThemeProvider } from '../components/theme-provider';

/**
 * A face with full Vietnamese coverage.
 *
 * A stack that begins with a Latin-only face renders diacritics from a
 * fallback, so accented letters sit at a different weight and height from the
 * ones beside them — legible, and visibly not the same typeface.
 */
const sans = Be_Vietnam_Pro({
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-be-vietnam-pro',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ViAI',
  description: 'AI Agent software for growing businesses',
  manifest: '/site.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-48x48.png', sizes: '48x48', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    images: ['/og-image.png'],
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // `lang` has to be the locale actually in use, not a constant: assistive
  // technology and the browser's own translation prompt both read it.
  const locale = await getLocale();

  return (
    // `suppressHydrationWarning` because the theme provider writes the class
    // on this element before React hydrates — which is the point, since doing
    // it afterwards would show a flash of the wrong theme on every load.
    <html
      className={cn('font-sans', sans.variable)}
      lang={locale}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background text-foreground antialiased">
        <ThemeProvider>
          <NextIntlClientProvider>{children}</NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
