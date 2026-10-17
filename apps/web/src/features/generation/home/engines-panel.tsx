'use client';

import { Skeleton } from '@bf/ui/components/skeleton';
import { CircleCheckIcon, CircleSlashIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useEngines } from '../api.ts';

// The engines (BF-046): whether each can run for this workspace, its load (running and waiting jobs) and its typical
// cost and time.

export function EnginesPanel() {
  const t = useTranslations('generation.home.engines');
  const names = useTranslations('generation.engines.name');
  const format = useFormatter();
  const engines = useEngines();
  return (
    <section aria-labelledby="engines-title" className="space-y-3 rounded-lg border p-4">
      <h2 id="engines-title" className="text-base font-semibold">
        {t('title')}
      </h2>
      {engines.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : engines.isError ? (
        <p className="text-sm text-destructive">{t('error')}</p>
      ) : (
        <ul className="space-y-3">
          {(engines.data?.items ?? []).map((engine) => (
            <li key={engine.id} className="space-y-0.5 text-sm" data-engine={engine.id}>
              <p className="flex items-center gap-2 font-medium">
                {engine.available ? (
                  <CircleCheckIcon aria-hidden className="size-4 text-emerald-700" />
                ) : (
                  <CircleSlashIcon aria-hidden className="size-4 text-muted-foreground" />
                )}
                {names(engine.id)}
                <span className="sr-only">{engine.available ? t('available') : t('unavailable')}</span>
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {t('load', { running: engine.running, queued: engine.queued })}
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {t('typical', {
                  cost: format.number(engine.capabilities.typicalCostUsd, {
                    style: 'currency',
                    currency: 'USD',
                  }),
                  minutes: Math.max(1, Math.round(engine.capabilities.typicalDurationSec / 60)),
                  parallel: engine.capabilities.maxParallel,
                })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
