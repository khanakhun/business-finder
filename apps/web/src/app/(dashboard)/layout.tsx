import type * as React from 'react';
import { AppShell } from '@/components/shell/app-shell.tsx';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
