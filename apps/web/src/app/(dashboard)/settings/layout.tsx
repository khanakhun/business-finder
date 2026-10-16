import type * as React from 'react';
import { SettingsNav } from '@/components/settings/settings-nav.tsx';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SettingsNav />
      {children}
    </>
  );
}
