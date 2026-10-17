'use client';

import type { EngineRequest, GenerationEngineListing } from '@bf/contracts';
import { useFormatter, useTranslations } from 'next-intl';
import { estimate } from '../engines.ts';

// The batch's typical cost and time (BF-046): typical figures of the chosen engines, laid on the run mode's lanes.
// Honest about what it is: an estimate before queues and repairs.

export function EstimatePanel({
  engines,
  listing,
  maxParallel,
}: {
  readonly engines: readonly EngineRequest[];
  readonly listing: GenerationEngineListing | undefined;
  readonly maxParallel: number;
}) {
  const t = useTranslations('generation.estimate');
  const format = useFormatter();
  const { costUsd, etaSec } = estimate(engines, listing, maxParallel);
  const waiting = (listing?.items ?? [])
    .filter((item) => engines.includes(item.id))
    .reduce((sum, item) => sum + item.queued, 0);
  return (
    <section aria-labelledby="estimate-title" className="space-y-1 rounded-lg border p-3 text-sm">
      <h3 id="estimate-title" className="font-medium">
        {t('title')}
      </h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">{t('cost')}</dt>
        <dd className="tabular-nums" data-testid="estimate-cost">
          {format.number(costUsd, { style: 'currency', currency: 'USD' })}
        </dd>
        <dt className="text-muted-foreground">{t('eta')}</dt>
        <dd className="tabular-nums" data-testid="estimate-eta">
          {t('minutes', { minutes: Math.max(1, Math.ceil(etaSec / 60)) })}
        </dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        {waiting > 0 ? t('queued', { count: waiting }) : t('note')}
      </p>
    </section>
  );
}
