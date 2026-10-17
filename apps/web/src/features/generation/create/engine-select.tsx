'use client';

import type { GenerationEngineListing } from '@bf/contracts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { useFormatter, useTranslations } from 'next-intl';
import { type PickableEngine, pickableEngines, unavailableReason } from '../engines.ts';

// The engine of an item (BF-046): every engine with its typical cost and duration and its live load; engines the
// workspace cannot use are listed, disabled, with why.

export function useEngineHint() {
  const t = useTranslations('generation.engines');
  const format = useFormatter();
  return (engine: PickableEngine, listing: GenerationEngineListing | undefined) => {
    if (engine === 'auto') return t('autoHint');
    const reason = unavailableReason(engine, listing);
    if (reason) return t(`why.${reason}`);
    const item = listing?.items.find((candidate) => candidate.id === engine);
    if (!item) return '';
    return t('hint', {
      cost: format.number(item.capabilities.typicalCostUsd, { style: 'currency', currency: 'USD' }),
      minutes: Math.max(1, Math.round(item.capabilities.typicalDurationSec / 60)),
      running: item.running,
      queued: item.queued,
    });
  };
}

export function EngineSelect({
  value,
  onChange,
  listing,
  label,
  id,
}: {
  readonly value: PickableEngine;
  readonly onChange: (engine: PickableEngine) => void;
  readonly listing: GenerationEngineListing | undefined;
  /** The accessible name (e.g. "Engine for Café du Port"). */
  readonly label: string;
  readonly id?: string;
}) {
  const t = useTranslations('generation.engines');
  const hint = useEngineHint();
  return (
    <Select value={value} onValueChange={(next) => onChange(next as PickableEngine)}>
      <SelectTrigger id={id} aria-label={label} className="w-full sm:w-56" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {pickableEngines(listing).map((engine) => (
          <SelectItem
            key={engine}
            value={engine}
            disabled={unavailableReason(engine, listing) !== null}
            textValue={t(`name.${engine}`)}
          >
            <span className="flex flex-col items-start">
              <span>{t(`name.${engine}`)}</span>
              <span className="text-xs text-muted-foreground">{hint(engine, listing)}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
