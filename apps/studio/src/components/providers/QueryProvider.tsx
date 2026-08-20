/**
 * The TanStack Query provider.
 *
 * `staleTime` is 30 s rather than 0: the control-plane lists in P1-01 change on human timescales,
 * and refetching a project list on every window focus is jitter without information. Editor
 * queries (P1-03) override it per key — the version row and the tree need to be fresher.
 *
 * `retry` excludes 4xx: retrying a `validation_failed` three times only delays the user's error
 * message by the backoff interval, and retrying a `revision_conflict` automatically is how you
 * get a silent overwrite — the exact failure the conflict dialog exists to prevent.
 */

'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api-client';

export function QueryProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              if (error instanceof ApiError && error.status < 500) return false;
              return failureCount < 2;
            },
          },
          mutations: { retry: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
