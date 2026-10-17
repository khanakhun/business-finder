'use client';

import dynamic from 'next/dynamic';
import * as React from 'react';
import { useComposerTarget } from './store.ts';

// The composer's one host in the dashboard layout (BF-051). The drawer (editor, previews, API hooks) loads the first
// time it opens, not with every page: the shell's JavaScript stays within its budget.

const ComposerDrawer = dynamic(() => import('./composer-drawer.tsx').then((m) => m.ComposerHost), {
  ssr: false,
});

export function ComposerHost() {
  const target = useComposerTarget();
  const [opened, setOpened] = React.useState(false);
  React.useEffect(() => {
    if (target) setOpened(true);
  }, [target]);
  return opened || target ? <ComposerDrawer /> : null;
}
