'use client';

import {
  FEATURE_DEFINITIONS,
  type FeatureKey,
  type ScoringProfileConfig,
  type Transform,
} from '@bf/contracts';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { useTranslations } from 'next-intl';
import { transformKinds, transformOfKind } from './draft.ts';
import { transformCurve } from './transform-curve.ts';

// Transforms (BF-032): how each weighted feature's raw value becomes 0–1 — a form per kind and a small chart of the
// curve (decorative: the fields carry the values).

type Locale = 'en' | 'fr';

function NumberField({
  id,
  label,
  value,
  onChange,
  readOnly,
  step = 'any',
  min,
  max,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly readOnly: boolean;
  readonly step?: string;
  readonly min?: number;
  readonly max?: number;
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        step={step}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        value={Number.isFinite(value) ? value : ''}
        disabled={readOnly}
        className="w-28"
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function Curve({ transform }: { readonly transform: Transform }) {
  const points = transformCurve(transform);
  if (!points) return null;
  const xs = points.map(([x]) => x);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const path = points
    .map(
      ([x, y], i) =>
        `${i === 0 ? 'M' : 'L'}${(((x - lo) / (hi - lo)) * 120).toFixed(1)},${(40 - y * 36 - 2).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg aria-hidden viewBox="0 0 120 40" className="h-10 w-30 shrink-0 text-primary">
      <line x1="0" y1="38" x2="120" y2="38" className="stroke-border" strokeWidth="1" />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function TransformFields({
  feature,
  transform,
  onChange,
  readOnly,
}: {
  readonly feature: FeatureKey;
  readonly transform: Transform;
  readonly onChange: (transform: Transform) => void;
  readonly readOnly: boolean;
}) {
  const t = useTranslations('scoringEditor.transforms');
  const id = (part: string) => `transform-${feature}-${part}`;
  switch (transform.kind) {
    case 'linear':
    case 'inverse':
      return (
        <div className="flex flex-wrap gap-3">
          <NumberField
            id={id('min')}
            label={t('min')}
            value={transform.min}
            readOnly={readOnly}
            onChange={(min) => onChange({ ...transform, min })}
          />
          <NumberField
            id={id('max')}
            label={t('max')}
            value={transform.max}
            readOnly={readOnly}
            onChange={(max) => onChange({ ...transform, max })}
          />
        </div>
      );
    case 'log':
      return (
        <NumberField
          id={id('max')}
          label={t('logMax')}
          value={transform.max}
          readOnly={readOnly}
          onChange={(max) => onChange({ ...transform, max })}
        />
      );
    case 'boolean':
      return (
        <div className="flex flex-wrap gap-3">
          {(['true', 'false'] as const).map((side) => (
            <NumberField
              key={side}
              id={id(side)}
              label={t(side)}
              value={transform[side]}
              step="0.05"
              min={0}
              max={1}
              readOnly={readOnly}
              onChange={(value) => onChange({ ...transform, [side]: value })}
            />
          ))}
        </div>
      );
    case 'enumMap':
      return (
        <EnumMapFields feature={feature} transform={transform} onChange={onChange} readOnly={readOnly} />
      );
    case 'piecewise':
      return (
        <div className="grid gap-1">
          <Label htmlFor={id('points')} className="text-xs text-muted-foreground">
            {t('points')}
          </Label>
          <Input
            id={id('points')}
            defaultValue={transform.points.map(([x, y]) => `${x}:${y}`).join(' ')}
            disabled={readOnly}
            aria-describedby={id('points-help')}
            onBlur={(event) => {
              const points = event.target.value
                .trim()
                .split(/\s+/)
                .map((pair) => pair.split(':').map(Number) as [number, number]);
              if (points.length >= 2 && points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)))
                onChange({ kind: 'piecewise', points });
            }}
          />
          <p id={id('points-help')} className="text-xs text-muted-foreground">
            {t('pointsHelp')}
          </p>
        </div>
      );
  }
}

function EnumMapFields({
  feature,
  transform,
  onChange,
  readOnly,
}: {
  readonly feature: FeatureKey;
  readonly transform: Extract<Transform, { kind: 'enumMap' }>;
  readonly onChange: (transform: Transform) => void;
  readonly readOnly: boolean;
}) {
  const t = useTranslations('scoringEditor.transforms');
  const values = FEATURE_DEFINITIONS[feature].values ?? [];
  return (
    <div className="flex flex-wrap gap-3">
      {values.map((value) => (
        <NumberField
          key={value}
          id={`transform-${feature}-${value}`}
          label={value}
          value={transform.map[value] ?? transform.default}
          step="0.05"
          min={0}
          max={1}
          readOnly={readOnly}
          onChange={(next) => onChange({ ...transform, map: { ...transform.map, [value]: next } })}
        />
      ))}
      <NumberField
        id={`transform-${feature}-default`}
        label={t('default')}
        value={transform.default}
        step="0.05"
        min={0}
        max={1}
        readOnly={readOnly}
        onChange={(next) => onChange({ ...transform, default: next })}
      />
    </div>
  );
}

export function TransformsEditor({
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
  const t = useTranslations('scoringEditor.transforms');
  const features = Object.keys(config.weights) as FeatureKey[];
  const set = (feature: FeatureKey, transform: Transform | undefined) => {
    const transforms = { ...config.transforms };
    if (transform) transforms[feature] = transform;
    else delete transforms[feature];
    onChange({ ...config, transforms });
  };
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      <ul className="grid gap-4">
        {features.map((feature) => {
          const definition = FEATURE_DEFINITIONS[feature];
          const transform = config.transforms[feature];
          const kinds = transformKinds(feature);
          return (
            <li
              key={feature}
              className="grid gap-3 rounded-md border p-3"
              data-testid={`transform-${feature}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm font-medium" title={definition.description[locale]}>
                  {definition.label[locale]}
                </span>
                <div className="flex items-center gap-3">
                  {transform ? <Curve transform={transform} /> : null}
                  <Select
                    value={transform?.kind ?? 'none'}
                    disabled={readOnly}
                    onValueChange={(kind) =>
                      set(
                        feature,
                        kind === 'none' ? undefined : transformOfKind(feature, kind as Transform['kind']),
                      )
                    }
                  >
                    <SelectTrigger
                      className="w-44"
                      aria-label={t('kindFor', { feature: definition.label[locale] })}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {definition.type === 'number' ? (
                        <SelectItem value="none">{t('kinds.none')}</SelectItem>
                      ) : null}
                      {kinds.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {t(`kinds.${kind}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {transform ? (
                <TransformFields
                  feature={feature}
                  transform={transform}
                  readOnly={readOnly}
                  onChange={(next) => set(feature, next)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
