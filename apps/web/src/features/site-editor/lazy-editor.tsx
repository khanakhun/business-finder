'use client';

import type { SiteVersion } from '@bf/contracts';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { usePermission } from '@/lib/session.tsx';

function Loading() {
  const t = useTranslations('siteEditor');
  return (
    <p className="text-muted-foreground p-6 text-sm" role="status">
      {t('loading')}
    </p>
  );
}

// The editor's bundle (Puck, the block library, the schema) loads only on this page, in the browser.
const SiteEditor = dynamic(() => import('./editor-shell.tsx').then((module) => module.SiteEditor), {
  ssr: false,
  loading: Loading,
});

/** The site editor, editable with `sites:generate` (read-only otherwise). */
export function LazySiteEditor({
  siteId,
  initialVersion,
}: {
  readonly siteId: string;
  readonly initialVersion: SiteVersion;
}) {
  const canEdit = usePermission('sites:generate');
  return <SiteEditor siteId={siteId} initialVersion={initialVersion} canEdit={canEdit} />;
}
