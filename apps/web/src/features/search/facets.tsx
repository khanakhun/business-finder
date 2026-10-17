'use client';

import type { BusinessFacets } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Skeleton } from '@bf/ui/components/skeleton';
import { cn } from '@bf/ui/lib/utils';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type * as React from 'react';
import { useSearchState } from './hooks.tsx';
import { FILTER_KEYS, type SearchState, type STATUSES } from './url-state.ts';

type Patch = Partial<SearchState>;

const RATING: Record<string, Patch | null> = {
  none: null,
  lt3: { 'rating[gte]': null, 'rating[lte]': 2.9 },
  '3to4': { 'rating[gte]': 3, 'rating[lte]': 3.9 },
  '4to4.5': { 'rating[gte]': 4, 'rating[lte]': 4.4 },
  'gte4.5': { 'rating[gte]': 4.5, 'rating[lte]': null },
};

function Group({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="px-2 text-sm font-semibold">{title}</h3>
      <ul className="space-y-px">{children}</ul>
    </section>
  );
}

function Row({
  label,
  count,
  active,
  onClick,
  indent = false,
}: {
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
  readonly onClick: (() => void) | null;
  readonly indent?: boolean;
}) {
  const format = useFormatter();
  return (
    <li>
      <button
        type="button"
        disabled={!onClick}
        aria-pressed={onClick ? active : undefined}
        onClick={onClick ?? undefined}
        className={cn(
          'flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1 text-left text-sm',
          'hover:bg-accent focus-visible:outline-2 focus-visible:outline-lagoon disabled:cursor-default disabled:hover:bg-transparent',
          active && 'bg-lagoon-wash font-medium text-lagoon',
          indent && 'pl-5',
        )}
      >
        <span className="truncate">{label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{format.number(count)}</span>
      </button>
    </li>
  );
}

const toggle = (values: readonly string[] | null, value: string) => {
  const current = values ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return next.length > 0 ? next : null;
};

/** Counts per dimension under the other filters (BF-022 semantics); a click applies or removes that filter. */
export function Facets({
  facets,
  loading,
}: {
  readonly facets: BusinessFacets | undefined;
  readonly loading: boolean;
}) {
  const t = useTranslations('search.facets');
  const status = useTranslations('search.status');
  const locale = useLocale();
  const [state, setState] = useSearchState();
  const set = (patch: Patch) => void setState(patch);
  if (!facets) {
    return loading ? (
      <div className="space-y-2 p-2" aria-busy>
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    ) : null;
  }
  const hasFilters = FILTER_KEYS.some((key) => key !== 'q' && state[key] !== null);
  return (
    <nav aria-label={t('title')} className="space-y-5">
      {facets.categories.length > 0 ? (
        <Group title={t('categories')}>
          {facets.categories.map((c) => (
            <Row
              key={c.id}
              label={c.labels[locale === 'fr' ? 'fr' : 'en']}
              count={c.count}
              indent={c.parentId !== null}
              active={state.category?.includes(c.id) ?? false}
              onClick={() => set({ category: toggle(state.category, c.id) })}
            />
          ))}
        </Group>
      ) : null}
      <Group title={t('status')}>
        {facets.pipelineStatuses.map((s) => (
          <Row
            key={s.value}
            label={status(s.value as (typeof STATUSES)[number])}
            count={s.count}
            active={state.status?.includes(s.value) ?? false}
            onClick={() => set({ status: toggle(state.status, s.value) })}
          />
        ))}
      </Group>
      <Group title={t('website')}>
        {facets.website.map((w) => (
          <Row
            key={w.value}
            label={w.value === 'has' ? t('has') : t('noneValue')}
            count={w.count}
            active={state.website === w.value}
            onClick={() => set({ website: state.website === w.value ? null : (w.value as 'has' | 'none') })}
          />
        ))}
      </Group>
      <Group title={t('email')}>
        {facets.email.map((e) => {
          const value = e.value === 'has' ? 'true' : 'false';
          return (
            <Row
              key={e.value}
              label={e.value === 'has' ? t('has') : t('noneValue')}
              count={e.count}
              active={state.hasEmail === value}
              onClick={() => set({ hasEmail: state.hasEmail === value ? null : value })}
            />
          );
        })}
      </Group>
      <Group title={t('rating')}>
        {facets.ratingBands.map((band) => {
          const patch = RATING[band.value] ?? null;
          const active =
            patch !== null &&
            state['rating[gte]'] === patch['rating[gte]'] &&
            state['rating[lte]'] === patch['rating[lte]'];
          return (
            <Row
              key={band.value}
              // Message keys cannot contain dots: `4to4.5` → `4to4_5`.
              label={t(
                `ratingBands.${band.value.replace('.', '_') as 'none' | 'lt3' | '3to4' | '4to4_5' | 'gte4_5'}`,
              )}
              count={band.count}
              active={active}
              onClick={
                patch ? () => set(active ? { 'rating[gte]': null, 'rating[lte]': null } : patch) : null
              }
            />
          );
        })}
      </Group>
      {facets.tiers.some((tier) => tier.value !== 'none') ? (
        <Group title={t('tiers')}>
          {facets.tiers.map((tier) => (
            <Row
              key={tier.value}
              label={tier.value === 'none' ? t('none') : tier.value}
              count={tier.count}
              active={state.tier?.includes(tier.value) ?? false}
              onClick={tier.value === 'none' ? null : () => set({ tier: toggle(state.tier, tier.value) })}
            />
          ))}
        </Group>
      ) : null}
      {facets.localities.length > 0 ? (
        <Group title={t('localities')}>
          {facets.localities.map((l) => (
            <Row
              key={l.value}
              label={l.value}
              count={l.count}
              active={state.keyword?.includes(l.value) ?? false}
              // No place filter in the API: the place name as a keyword (the full-text document includes it).
              onClick={() => set({ keyword: toggle(state.keyword, l.value) })}
            />
          ))}
        </Group>
      ) : null}
      {hasFilters ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => set(Object.fromEntries(FILTER_KEYS.filter((k) => k !== 'q').map((k) => [k, null])))}
        >
          {t('clear')}
        </Button>
      ) : null}
    </nav>
  );
}
