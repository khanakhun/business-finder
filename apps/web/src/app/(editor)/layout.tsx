import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type * as React from 'react';
import { WorkspaceGate } from '@/components/shell/workspace-gate.tsx';
import { getSession } from '@/lib/server-session.ts';
import { SessionProvider } from '@/lib/session.tsx';

/**
 * Full-screen tools outside the dashboard chrome (BF-037: the site editor). Same protection as the dashboard: the
 * API decides who is signed in, and the page needs an active workspace.
 */
export default async function EditorLayout({ children }: { children: React.ReactNode }) {
  const path = (await headers()).get('x-pathname') ?? '/';
  const me = await getSession();
  if (!me) redirect(`/sign-in?next=${encodeURIComponent(path)}`);
  return (
    <SessionProvider me={me}>
      <WorkspaceGate>{children}</WorkspaceGate>
    </SessionProvider>
  );
}
