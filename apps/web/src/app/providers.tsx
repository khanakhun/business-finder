'use client';

import { shouldRetry } from '@bf/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { ThemeProvider } from 'next-themes';
import * as React from 'react';
import { CommandRegistryProvider } from '@/lib/commands.tsx';

// Toasts are never needed for first paint; the renderer loads after hydration.
const Toaster = dynamic(() => import('@bf/ui/components/sonner').then((m) => m.Toaster), { ssr: false });

const ReactQueryDevtools =
  process.env.NODE_ENV === 'development'
    ? React.lazy(() =>
        import('@tanstack/react-query-devtools').then((m) => ({ default: m.ReactQueryDevtools })),
      )
    : () => null;

export function Providers({
  children,
  nonce,
}: {
  readonly children: React.ReactNode;
  readonly nonce: string | undefined;
}) {
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
        <Toaster position="bottom-right" />
        <React.Suspense>
          <ReactQueryDevtools />
        </React.Suspense>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
