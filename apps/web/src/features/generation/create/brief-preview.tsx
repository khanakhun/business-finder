'use client';

import { BRIEF_STYLES, type BriefOverrides } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Checkbox } from '@bf/ui/components/checkbox';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Textarea } from '@bf/ui/components/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@bf/ui/components/tooltip';
import { AlertTriangleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useBrief } from '../api.ts';

// One item's brief, before it runs (BF-046 on BF-040): the page plan, locales, style and palette, the selling points
// and what is missing; and the overrides a person may set (locales, style, page plan, instructions ≤ 500 chars).

const LOCALES = ['fr', 'en'] as const;
const KEEP = '__brief__';
export const MAX_INSTRUCTIONS = 500;

export function BriefPreview({
  businessId,
  overrides,
  onChange,
}: {
  readonly businessId: string;
  readonly overrides: BriefOverrides;
  readonly onChange: (overrides: BriefOverrides) => void;
}) {
  const t = useTranslations('generation.brief');
  const brief = useBrief(businessId, true);
  if (brief.isLoading) return <Skeleton className="h-32 w-full" />;
  if (brief.isError || !brief.data) return <p className="text-sm text-destructive">{t('error')}</p>;
  const { brief: b, pagePlans } = brief.data;
  const set = (patch: Partial<BriefOverrides>) => {
    const next: Record<string, unknown> = { ...overrides, ...patch };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    onChange(next as BriefOverrides);
  };
  const locales = overrides.locales ?? b.locales.available;
  const toggleLocale = (locale: string, on: boolean) => {
    const next = on ? [...new Set([...locales, locale])] : locales.filter((l) => l !== locale);
    if (next.length > 0) set({ locales: next });
  };
  const id = (name: string) => `brief-${businessId}-${name}`;
  return (
    <div className="space-y-4 rounded-md bg-surface-sunken/50 p-3 text-sm">
      <section aria-label={t('plan')} className="space-y-1">
        <h3 className="text-xs font-medium uppercase text-muted-foreground">{t('plan')}</h3>
        <ul className="flex flex-wrap gap-1">
          {b.pagePlan.pages.map((page) => (
            <li key={page.kind}>
              <Badge variant="secondary">{t(`pages.${page.kind}`)}</Badge>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-wrap items-center gap-3">
        <span>
          {t('style')}: <strong>{t(`styles.${b.design.style}`)}</strong>
        </span>
        <span
          role="img"
          className="flex items-center gap-1"
          aria-label={`${t('palette')}: ${b.design.palette.primary}, ${b.design.palette.accent}`}
        >
          {[b.design.palette.primary, b.design.palette.accent].map((color) => (
            <span
              key={color}
              title={color}
              className="inline-block size-4 rounded-full border"
              style={{ backgroundColor: color }}
            />
          ))}
        </span>
        <span>
          {t('locales')}: <strong>{b.locales.available.join(', ').toUpperCase()}</strong>
        </span>
      </section>
      {b.sellingPoints.length > 0 ? (
        <section className="space-y-1">
          <h3 className="text-xs font-medium uppercase text-muted-foreground">{t('sellingPoints')}</h3>
          <ul className="list-disc space-y-0.5 pl-5">
            {b.sellingPoints.map((point) => (
              <li key={point.text}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className="cursor-help text-left underline decoration-dotted">
                      {point.text}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t('evidence', { count: point.evidence.length })}</TooltipContent>
                </Tooltip>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {b.warnings.length > 0 ? (
        <ul className="space-y-1" aria-label={t('warningsLabel')}>
          {b.warnings.map((warning) => (
            <li key={warning.code} className="flex items-start gap-1.5 text-amber-800 dark:text-amber-200">
              <AlertTriangleIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              {t.has(`warnings.${warning.code}`) ? t(`warnings.${warning.code}`) : warning.message}
            </li>
          ))}
        </ul>
      ) : null}
      <fieldset className="grid gap-3 border-t pt-3 sm:grid-cols-2">
        <legend className="sr-only">{t('overrides')}</legend>
        <div className="space-y-1">
          <span className="text-xs font-medium">{t('locales')}</span>
          <div className="flex gap-3">
            {LOCALES.map((locale) => (
              <Label key={locale} className="flex items-center gap-1.5 font-normal">
                <Checkbox
                  checked={locales.includes(locale)}
                  onCheckedChange={(on) => toggleLocale(locale, on === true)}
                />
                {locale.toUpperCase()}
              </Label>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor={id('style')} className="text-xs">
            {t('style')}
          </Label>
          <Select
            value={overrides.style ?? KEEP}
            onValueChange={(value) =>
              set({ style: value === KEEP ? undefined : (value as BriefOverrides['style']) })
            }
          >
            <SelectTrigger id={id('style')} size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP}>{t('fromBrief', { value: t(`styles.${b.design.style}`) })}</SelectItem>
              {BRIEF_STYLES.map((style) => (
                <SelectItem key={style} value={style}>
                  {t(`styles.${style}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {pagePlans.length > 1 ? (
          <div className="space-y-1">
            <Label htmlFor={id('plan')} className="text-xs">
              {t('plan')}
            </Label>
            <Select
              value={overrides.pagePlanId ?? KEEP}
              onValueChange={(value) => set({ pagePlanId: value === KEEP ? undefined : value })}
            >
              <SelectTrigger id={id('plan')} size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={KEEP}>{t('fromBrief', { value: b.pagePlan.id })}</SelectItem>
                {pagePlans.map((plan) => (
                  <SelectItem key={plan.id} value={plan.id}>
                    {plan.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={id('instructions')} className="text-xs">
            {t('instructions')}
          </Label>
          <Textarea
            id={id('instructions')}
            rows={2}
            maxLength={MAX_INSTRUCTIONS}
            value={overrides.extraInstructions ?? ''}
            placeholder={t('instructionsHint')}
            onChange={(event) => set({ extraInstructions: event.target.value || undefined })}
          />
          <p className="text-right text-xs text-muted-foreground tabular-nums">
            {(overrides.extraInstructions ?? '').length}/{MAX_INSTRUCTIONS}
          </p>
        </div>
      </fieldset>
    </div>
  );
}
