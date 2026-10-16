'use client';

import type { ScoringProfileConfig } from '@bf/contracts';
import { Label } from '@bf/ui/components/label';
import { useTranslations } from 'next-intl';
import { NumericInput } from './numeric-input.tsx';

// Tier thresholds (BF-032): A from `A` points, B from `B`, C below; X is decided by gates (or do-not-contact).

export function TiersEditor({
  config,
  onChange,
  readOnly,
}: {
  readonly config: ScoringProfileConfig;
  readonly onChange: (config: ScoringProfileConfig) => void;
  readonly readOnly: boolean;
}) {
  const t = useTranslations('scoringEditor.tiers');
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      <div className="flex flex-wrap gap-4">
        {(['A', 'B'] as const).map((tier) => (
          <div key={tier} className="grid gap-1">
            <Label htmlFor={`tier-${tier}`}>{t('from', { tier })}</Label>
            <NumericInput
              id={`tier-${tier}`}
              integer
              min={tier === 'A' ? 1 : 0}
              max={tier === 'A' ? 100 : 99}
              value={config.tiers[tier]}
              disabled={readOnly}
              className="w-28"
              onCommit={(value) => onChange({ ...config, tiers: { ...config.tiers, [tier]: value } })}
            />
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {t('summary', { a: config.tiers.A, b: config.tiers.B })}
      </p>
    </div>
  );
}
