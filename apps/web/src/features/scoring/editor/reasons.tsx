'use client';

import {
  FEATURE_DEFINITIONS,
  type FeatureKey,
  type ScoringProfileConfig,
  unknownPlaceholders,
} from '@bf/contracts';
import { Label } from '@bf/ui/components/label';
import { Textarea } from '@bf/ui/components/textarea';
import { useTranslations } from 'next-intl';
import { reasonKeys } from './draft.ts';

// Reason templates (BF-032): the profile's own EN/FR texts for a feature's values, read before the registry's; empty
// means the registry's text (shown as the placeholder). Only `{value}` may be filled in.

type Locale = 'en' | 'fr';

export function ReasonsEditor({
  config,
  onChange,
  locale,
  readOnly,
}: {
  readonly config: ScoringProfileConfig;
  readonly onChange: (config: ScoringProfileConfig) => void;
  readonly locale: Locale;
  readonly readOnly: boolean;
}) {
  const t = useTranslations('scoringEditor.reasons');
  const features = Object.keys(config.weights) as FeatureKey[];
  const set = (feature: FeatureKey, key: string, language: Locale, text: string) => {
    const current = { ...(config.reasonTemplates[feature] ?? {}) };
    const entry = { en: current[key]?.en ?? '', fr: current[key]?.fr ?? '', [language]: text };
    if (entry.en === '' && entry.fr === '') delete current[key];
    else current[key] = entry;
    const reasonTemplates = { ...config.reasonTemplates };
    if (Object.keys(current).length === 0) delete reasonTemplates[feature];
    else reasonTemplates[feature] = current;
    onChange({ ...config, reasonTemplates });
  };
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      {features.map((feature) => {
        const definition = FEATURE_DEFINITIONS[feature];
        return (
          <details key={feature} className="rounded-md border p-3" data-testid={`reasons-${feature}`}>
            <summary className="cursor-pointer text-sm font-medium">{definition.label[locale]}</summary>
            <div className="mt-3 grid gap-3">
              {reasonKeys(feature, config).map((key) => (
                <fieldset key={key} className="grid gap-2 sm:grid-cols-2">
                  <legend className="mb-1 text-xs text-muted-foreground">{t('key', { key })}</legend>
                  {(['en', 'fr'] as const).map((language) => {
                    const id = `reason-${feature}-${key}-${language}`;
                    const text = config.reasonTemplates[feature]?.[key]?.[language] ?? '';
                    const unknown = unknownPlaceholders(text);
                    return (
                      <div key={language} className="grid gap-1">
                        <Label htmlFor={id} className="text-xs">
                          {t(`language.${language}`)}
                        </Label>
                        <Textarea
                          id={id}
                          value={text}
                          rows={2}
                          maxLength={300}
                          disabled={readOnly}
                          placeholder={definition.reasons[key]?.[language] ?? ''}
                          aria-invalid={unknown.length > 0}
                          aria-describedby={unknown.length > 0 ? `${id}-error` : undefined}
                          onChange={(event) => set(feature, key, language, event.target.value)}
                        />
                        {unknown.length > 0 ? (
                          <p id={`${id}-error`} className="text-xs text-destructive">
                            {t('unknownPlaceholder', { placeholders: unknown.join(', ') })}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </fieldset>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}
