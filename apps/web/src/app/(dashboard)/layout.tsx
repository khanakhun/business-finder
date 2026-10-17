import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import type * as React from 'react';
import { AppShell } from '@/components/shell/app-shell.tsx';
import { WorkspaceGate } from '@/components/shell/workspace-gate.tsx';
import { ComposerHost } from '@/features/outreach/composer/composer-host.tsx';
import { RealtimeProvider } from '@/lib/realtime/provider.tsx';
import { getSession } from '@/lib/server-session.ts';
import { SessionProvider } from '@/lib/session.tsx';

/** Protected area: the API decides who is signed in (`GET /v1/me`); signed-out visitors go to sign-in. */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const path = (await headers()).get('x-pathname') ?? '/';
  const me = await getSession();
  if (!me) redirect(`/sign-in?next=${encodeURIComponent(path)}`);
  return (
    <SessionProvider me={me}>
      <RealtimeProvider enabled={me.activeOrganization !== null}>
        <AppShell>
          <WorkspaceGate>
            {/* URL state (search filters, views) for every dashboard page. */}
            <NuqsAdapter>
              {children}
              <ComposerHost />
            </NuqsAdapter>
          </WorkspaceGate>
        </AppShell>
      </RealtimeProvider>
    </SessionProvider>
  );
}
