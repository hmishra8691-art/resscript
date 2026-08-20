import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { QueryProvider } from '@/components/providers/QueryProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'ResScript Studio',
  description: 'Survey authoring control plane',
};

/**
 * The root layout is a Server Component and stays free of data fetching on purpose: the shell
 * chrome must paint before any authenticated request resolves, and a layout that awaited the
 * session would block every route on one round trip.
 */
export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
