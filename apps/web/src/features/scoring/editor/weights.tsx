'use client';

import {
  FEATURE_DEFINITIONS,
  FEATURE_GROUPS,
  type FeatureKey,
  type ScoringProfileConfig,
} from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { XIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { normalizedWeights, unweighted, withoutFeature, withWeight } from './draft.ts';
import { NumericInput } from './numeric-input.tsx';

// Weights (BF-032): a slider and a number per feature (−100…100), with each weight's share of the positive ones.

const clamp = (value: number) => Math.max(-100, Math.min(100, Math.round(value)));

export function WeightsEditor({
  config,
  onChange,
  locale,
  readOnly,
}: {
  readonly config: ScoringProfileConfig;
  readonly onChange: (config: ScoringProfileConfig) => void;
  readonly locale: 'en' | 'fr';
  readonly readOnly: boolean;
}) {
  const t = useTranslations('scoringEditor.weights');
  const format = useFormatter();
  const shares = normalizedWeights(config.weights);
  const features = (Object.keys(config.weights) as FeatureKey[]).sort(
    (a, b) =>
      FEATURE_GROUPS.indexOf(FEATURE_DEFINITIONS[a].group) -
      FEATURE_GROUPS.indexOf(FEATURE_DEFINITIONS[b].group),
  );
  const available = unweighted(config);
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      <ul className="grid gap-3">
        {features.map((feature) => {
          const weight = config.weights[feature] ?? 0;
          const definition = FEATURE_DEFINITIONS[feature];
          const id = `weight-${feature}`;
          return (
            <li
              key={feature}
              className="grid gap-2 sm:grid-cols-[14rem_1fr_6rem_4.5rem_2.5rem] sm:items-center"
            >
              <label htmlFor={id} className="text-sm font-medium" title={definition.description[locale]}>
                {definition.label[locale]}
              </label>
              <input
                type="range"
                min={-100}
                max={100}
                step={1}
                value={weight}
                disabled={readOnly}
                aria-label={t('slider', { feature: definition.label[locale] })}
                className="w-full accent-primary"
                onChange={(event) => onChange(withWeight(config, feature, clamp(Number(event.target.value))))}
              />
              <NumericInput
                id={id}
                integer
                min={-100}
                max={100}
                value={weight}
                disabled={readOnly}
                onCommit={(value) => onChange(withWeight(config, feature, clamp(value)))}
              />
              <span
                className="text-right text-sm tabular-nums text-muted-foreground"
                data-testid={`share-${feature}`}
              >
                {format.number(shares.get(feature) ?? 0, { style: 'percent', maximumFractionDigits: 0 })}
              </span>
              {readOnly ? (
                <span />
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('remove', { feature: definition.label[locale] })}
                  onClick={() => onChange(withoutFeature(config, feature))}
                >
                  <XIcon aria-hidden />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {!readOnly && available.length > 0 ? (
        <div className="flex items-center gap-2">
          <Select
            value=""
            onValueChange={(feature) => onChange(withWeight(config, feature as FeatureKey, 10))}
          >
            <SelectTrigger className="w-72" aria-label={t('add')}>
              <SelectValue placeholder={t('add')} />
            </SelectTrigger>
            <SelectContent>
              {available.map((feature) => (
                <SelectItem key={feature} value={feature}>
                  {FEATURE_DEFINITIONS[feature].label[locale]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  );
}
