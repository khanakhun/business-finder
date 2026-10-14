'use client';

import { shouldRetry } from '@bf/api-client';
import { Toaster } from '@bf/ui/components/sonner';
import { TooltipProvider } from '@bf/ui/components/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import * as React from 'react';
import { CommandRegistryProvider } from '@/lib/commands.tsx';

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
        <TooltipProvider delayDuration={300}>
          <CommandRegistryProvider>{children}</CommandRegistryProvider>
        </TooltipProvider>
        <Toaster position="bottom-right" />
        <React.Suspense>
          <ReactQueryDevtools />
        </React.Suspense>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
