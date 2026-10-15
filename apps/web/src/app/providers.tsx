'use client';

import { shouldRetry } from '@bf/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import * as React from 'react';
import { CommandRegistryProvider } from '@/lib/commands.tsx';
import { type PublicEnv, setPublicEnv } from '@/lib/public-env.ts';
import { ToastHost } from '@/lib/toast.tsx';

const ReactQueryDevtools =
  process.env.NODE_ENV === 'development'
    ? React.lazy(() =>
        import('@tanstack/react-query-devtools').then((m) => ({ default: m.ReactQueryDevtools })),
      )
    : () => null;

export function Providers({
  children,
  nonce,
  publicEnv,
}: {
  readonly children: React.ReactNode;
  readonly nonce: string | undefined;
  /** This deployment's public URLs, read by the server at run time (lib/public-env.ts). */
  readonly publicEnv: PublicEnv;
}) {
  // During render, so it is in place before any child renders or runs an effect (idempotent).
  setPublicEnv(publicEnv);
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // Retry only reads (queries), and only network/5xx failures; never mutations.
          queries: { staleTime: 30_000, retry: shouldRetry, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...(nonce ? { nonce } : {})}
    >
      <QueryClientProvider client={queryClient}>
        <CommandRegistryProvider>{children}</CommandRegistryProvider>
        <ToastHost position="bottom-right" />
        <React.Suspense>
          <ReactQueryDevtools />
        </React.Suspense>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
