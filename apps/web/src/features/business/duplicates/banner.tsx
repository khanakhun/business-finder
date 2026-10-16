'use client';

import type { BusinessDetail, PossibleDuplicate } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { CopyIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { usePermission } from '@/lib/session.tsx';
import { useDuplicates } from '../api.ts';

const CompareDialog = dynamic(() => import('./compare-dialog.tsx').then((m) => m.CompareDialog), {
  ssr: false,
});

/** "This business may be the same as …": open pairs involving it, each one a compare-and-merge away. */
export function DuplicatesBanner({ business }: { readonly business: BusinessDetail }) {
  const t = useTranslations('business.duplicates');
  const canWrite = usePermission('business:write');
  const duplicates = useDuplicates(business.id);
  const [comparing, setComparing] = React.useState<PossibleDuplicate | null>(null);
  const pairs = duplicates.data?.items ?? [];
  if (pairs.length === 0) return null;
  return (
    <section
      aria-label={t('label')}
      className="flex flex-col gap-2 rounded-lg border border-buoy/40 bg-buoy-wash px-4 py-3 text-sm"
    >
      {pairs.map((pair) => {
        const other = pair.businessA.id === business.id ? pair.businessB : pair.businessA;
        return (
          <div key={pair.id} className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2">
              <CopyIcon aria-hidden className="size-4 shrink-0 text-buoy" />
              {t('maybe', {
                name: other.displayName,
                locality: other.locality ?? '',
                score: Math.round(pair.score * 100),
              })}
            </p>
            {canWrite ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setComparing(pair)}>
                {t('compare')}
              </Button>
            ) : null}
          </div>
        );
      })}
      {comparing ? (
        <CompareDialog current={business} pair={comparing} onClose={() => setComparing(null)} />
      ) : null}
    </section>
  );
}
