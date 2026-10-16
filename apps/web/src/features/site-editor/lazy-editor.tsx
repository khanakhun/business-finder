'use client';

import type { SiteDetail, SiteVersion } from '@bf/contracts';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { usePermission, useSession } from '@/lib/session.tsx';

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

/** The site editor, editable with `sites:generate` (read-only otherwise), published with `sites:publish`. */
export function LazySiteEditor({
  siteId,
  initialSite,
  initialVersion,
}: {
  readonly siteId: string;
  readonly initialSite: SiteDetail;
  readonly initialVersion: SiteVersion;
}) {
  const canEdit = usePermission('sites:generate');
  const canPublish = usePermission('sites:publish');
  const canAdmin = usePermission('sites:admin');
  const me = useSession();
  return (
    <SiteEditor
      siteId={siteId}
      initialSite={initialSite}
      initialVersion={initialVersion}
      canEdit={canEdit}
      canPublish={canPublish}
      canAdmin={canAdmin}
      userId={me.user.id}
      organizationId={me.activeOrganization?.id ?? ''}
    />
  );
}
