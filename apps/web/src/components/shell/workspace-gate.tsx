'use client';

import { EmptyState } from '@bf/ui/components/empty-state';
import { BuildingIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type * as React from 'react';
import { useSession } from '@/lib/session.tsx';

// Pages that work without an active workspace (the caller acting on themselves).
const WORKSPACE_FREE = ['/settings/account'];

/**
 * Shows the page, or an explanation when it needs a workspace and the user has none active. Client-side, because the
 * dashboard layout is not re-rendered on client navigation (a path read there would go stale).
 */
export function WorkspaceGate({ children }: { readonly children: React.ReactNode }) {
  const t = useTranslations('workspace');
  const { activeOrganization } = useSession();
  const path = usePathname();
  if (activeOrganization || WORKSPACE_FREE.includes(path)) return children;
  return (
    <EmptyState icon={<BuildingIcon aria-hidden />} title={t('noneTitle')} description={t('noneBody')} />
  );
}
