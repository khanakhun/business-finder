'use client';

import type { AreaCandidate } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { CategoryPicker } from '@bf/ui/components/category-picker';
import { Checkbox } from '@bf/ui/components/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@bf/ui/components/dropdown-menu';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@bf/ui/components/popover';
import { cn } from '@bf/ui/lib/utils';
import { PlusIcon, XIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { useArea, useCategories, useSearchState } from './hooks.tsx';
import { type FilterKey, locationOf, type SearchState, STATUSES } from './url-state.ts';

type Patch = Partial<SearchState>;

/** One editable piece of the search, read as a phrase ("with an email"), opening its editor on click. */
function Chip({
  label,
  removeLabel,
  onRemove,
  children,
  tone = 'default',
}: {
  readonly label: React.ReactNode;
  readonly removeLabel: string;
  readonly onRemove?: () => void;
  readonly children?: React.ReactNode;
  readonly tone?: 'default' | 'place';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border bg-surface text-sm shadow-xs',
        tone === 'place' ? 'border-lagoon/50' : 'border-border',
      )}
    >
      {children ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="rounded-l-full py-1 pr-1.5 pl-3 hover:text-lagoon focus-visible:outline-2 focus-visible:outline-lagoon"
            >
              {label}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 space-y-3">
            {children}
          </PopoverContent>
        </Popover>
      ) : (
        <span className="py-1 pr-1.5 pl-3">{label}</span>
      )}
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          className="rounded-r-full py-1 pr-2.5 pl-1 text-muted-foreground hover:text-reef focus-visible:outline-2 focus-visible:outline-lagoon"
          onClick={onRemove}
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </span>
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
  name,
}: {
  readonly value: T | null;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T) => void;
  readonly name: string;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="sr-only">{name}</legend>
      {options.map((option) => (
        <label key={option.value} className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={name}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="accent-lagoon"
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

function Range({
  label,
  min,
  max,
  step,
  low,
  high,
  onChange,
}: {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly low: number | null;
  readonly high: number | null;
  readonly onChange: (low: number | null, high: number | null) => void;
}) {
  const t = useTranslations('search.chips');
  const parse = (value: string) => (value === '' ? null : Math.min(max, Math.max(min, Number(value))));
  const id = React.useId();
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-min`}>{t('atLeast')}</Label>
          <Input
            id={`${id}-min`}
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={step}
            defaultValue={low ?? ''}
            onBlur={(e) => onChange(parse(e.target.value), high)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-max`}>{t('atMost')}</Label>
          <Input
            id={`${id}-max`}
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={step}
            defaultValue={high ?? ''}
            onBlur={(e) => onChange(low, parse(e.target.value))}
          />
        </div>
      </div>
    </fieldset>
  );
}

const rangeLabel = (
  t: ReturnType<typeof useTranslations>,
  key: 'rating' | 'reviews',
  low: number | null,
  high: number | null,
) =>
  low !== null && high !== null
    ? t(`${key}Between`, { low, high })
    : low !== null
      ? t(`${key}AtLeast`, { low })
      : t(`${key}AtMost`, { high: high ?? 0 });

/**
 * The search as editable phrases (BF-023): categories, place, filters and keywords. Edits change the URL (and so
 * the results) without reading the prompt again.
 */
export function IntentChips({ candidates }: { readonly candidates: readonly AreaCandidate[] }) {
  const t = useTranslations('search.chips');
  const statusLabel = useTranslations('search.status');
  const discovery = useTranslations('search.discovery');
  const format = useFormatter();
  const [state, setState] = useSearchState();
  const { labels, picker } = useCategories();
  const area = useArea(state.area);
  const set = (patch: Patch) => void setState(patch);
  const remove = (label: string) => t('remove', { label });

  const chips: React.ReactNode[] = [];
  const categories = state.category ?? [];
  const pickerLabels = {
    placeholder: t('categoriesPlaceholder'),
    searchPlaceholder: t('categoriesSearch'),
    emptyText: t('categoriesEmpty'),
    remove,
    more: (count: number) => t('more', { count }),
    selected: t('selected'),
  };
  if (categories.length > 0) {
    const names = categories.map((id) => labels.get(id)?.label ?? '…');
    chips.push(
      <Chip
        key="category"
        label={format.list(names, { type: 'disjunction' })}
        removeLabel={remove(t('categories'))}
        onRemove={() => set({ category: null })}
      >
        <CategoryPicker
          tree={picker}
          value={categories}
          onChange={(value) => set({ category: value.length > 0 ? value : null })}
          labels={pickerLabels}
        />
      </Chip>,
    );
  }

  if (state.area || state.near) {
    const place = state.area
      ? (area.data?.properties.label ?? '…')
      : t('near', { km: format.number(state.radiusKm ?? 5, { maximumFractionDigits: 1 }) });
    chips.push(
      <Chip
        key="place"
        tone="place"
        label={t('in', { place })}
        removeLabel={remove(t('place'))}
        onRemove={() => set({ area: null, near: null, radiusKm: null })}
      >
        {state.near ? (
          <div className="space-y-1">
            <Label htmlFor="radius">{t('radius', { km: state.radiusKm ?? 5 })}</Label>
            <input
              id="radius"
              type="range"
              min={0.5}
              max={50}
              step={0.5}
              defaultValue={state.radiusKm ?? 5}
              className="w-full accent-lagoon"
              onPointerUp={(e) => set({ radiusKm: Number((e.target as HTMLInputElement).value) })}
              onKeyUp={(e) => set({ radiusKm: Number((e.target as HTMLInputElement).value) })}
            />
          </div>
        ) : null}
        {candidates.length > 1 ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('otherPlaces')}</p>
            <ul className="max-h-48 space-y-1 overflow-auto">
              {candidates.map((candidate) => (
                <li key={`${candidate.label}-${candidate.areaId ?? ''}`}>
                  <button
                    type="button"
                    className="w-full rounded px-2 py-1 text-left text-sm hover:bg-accent"
                    onClick={() => set(locationOf(candidate))}
                  >
                    {candidate.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">{t('drawHint')}</p>
      </Chip>,
    );
  }

  if (state.website && state.website !== 'any') {
    chips.push(
      <Chip
        key="website"
        label={t(`website.${state.website}`)}
        removeLabel={remove(t('websiteName'))}
        onRemove={() => set({ website: null })}
      >
        <Choice
          name={t('websiteName')}
          value={state.website}
          onChange={(website) => set({ website })}
          options={(['none', 'has', 'weak'] as const).map((value) => ({
            value,
            label: t(`website.${value}`),
          }))}
        />
      </Chip>,
    );
  }

  for (const key of ['rating', 'reviews'] as const) {
    const low = state[`${key}[gte]`];
    const high = state[`${key}[lte]`];
    if (low === null && high === null) continue;
    chips.push(
      <Chip
        key={key}
        label={rangeLabel(t, key, low, high)}
        removeLabel={remove(t(`${key}Name`))}
        onRemove={() => set({ [`${key}[gte]`]: null, [`${key}[lte]`]: null })}
      >
        <Range
          label={t(`${key}Name`)}
          min={key === 'rating' ? 0 : 0}
          max={key === 'rating' ? 5 : 100_000}
          step={key === 'rating' ? 0.5 : 1}
          low={low}
          high={high}
          onChange={(gte, lte) => set({ [`${key}[gte]`]: gte, [`${key}[lte]`]: lte })}
        />
      </Chip>,
    );
  }

  for (const key of ['hasEmail', 'emailVerified', 'hasPhone'] as const) {
    const value = state[key];
    if (!value) continue;
    chips.push(
      <Chip
        key={key}
        label={t(`${key}.${value}`)}
        removeLabel={remove(t(`${key}.name`))}
        onRemove={() => set({ [key]: null })}
      >
        <Choice
          name={t(`${key}.name`)}
          value={value}
          onChange={(next) => set({ [key]: next })}
          options={(['true', 'false'] as const).map((v) => ({ value: v, label: t(`${key}.${v}`) }))}
        />
      </Chip>,
    );
  }

  if (state.status?.length) {
    const statuses = state.status;
    chips.push(
      <Chip
        key="status"
        label={format.list(
          statuses.map((s) => statusLabel(s as (typeof STATUSES)[number])),
          { type: 'disjunction' },
        )}
        removeLabel={remove(t('statusName'))}
        onRemove={() => set({ status: null })}
      >
        <fieldset className="grid grid-cols-2 gap-1.5">
          <legend className="sr-only">{t('statusName')}</legend>
          {STATUSES.map((status) => (
            <div key={status} className="flex items-center gap-2 text-sm">
              <Checkbox
                id={`status-${status}`}
                checked={statuses.includes(status)}
                onCheckedChange={(checked) => {
                  const next = checked ? [...statuses, status] : statuses.filter((s) => s !== status);
                  set({ status: next.length > 0 ? next : null });
                }}
              />
              <Label htmlFor={`status-${status}`} className="font-normal">
                {statusLabel(status)}
              </Label>
            </div>
          ))}
        </fieldset>
      </Chip>,
    );
  }

  if (state.tag?.length) {
    chips.push(
      <Chip
        key="tag"
        label={t('tagged', { tags: format.list(state.tag, { type: 'disjunction' }) })}
        removeLabel={remove(t('tagsName'))}
        onRemove={() => set({ tag: null })}
      >
        <Label htmlFor="tags-edit">{t('tagsName')}</Label>
        <Input
          id="tags-edit"
          defaultValue={state.tag.join(', ')}
          onBlur={(e) => {
            const tags = e.target.value
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean);
            set({ tag: tags.length > 0 ? tags : null });
          }}
        />
      </Chip>,
    );
  }

  if (state.addedWithinDays) {
    chips.push(
      <Chip
        key="added"
        label={t('addedWithin', { days: state.addedWithinDays })}
        removeLabel={remove(t('addedName'))}
        onRemove={() => set({ addedWithinDays: null })}
      >
        <Choice
          name={t('addedName')}
          value={String(state.addedWithinDays)}
          onChange={(days) => set({ addedWithinDays: Number(days) })}
          options={['1', '7', '30', '90'].map((days) => ({ value: days, label: t('addedWithin', { days }) }))}
        />
      </Chip>,
    );
  }

  for (const keyword of state.keyword ?? []) {
    chips.push(
      <Chip
        key={`kw-${keyword}`}
        label={t('mentions', { keyword })}
        removeLabel={remove(keyword)}
        onRemove={() => {
          const next = (state.keyword ?? []).filter((k) => k !== keyword);
          set({ keyword: next.length > 0 ? next : null });
        }}
      />,
    );
  }

  if (state.q) {
    chips.push(
      <Chip
        key="q"
        label={t('text', { text: state.q })}
        removeLabel={remove(state.q)}
        onRemove={() => set({ q: null })}
      />,
    );
  }

  if (state.run) {
    chips.push(
      <Chip
        key="run"
        tone="place"
        label={discovery('runChip')}
        removeLabel={remove(discovery('runChip'))}
        onRemove={() => set({ run: null })}
      />,
    );
  }

  if (state.list) {
    chips.push(
      <Chip
        key="list"
        label={t('inList')}
        removeLabel={remove(t('inList'))}
        onRemove={() => set({ list: null })}
      />,
    );
  }

  const missing: Array<{
    key: FilterKey;
    label: 'website' | 'rating' | 'reviews' | 'hasEmail' | 'hasPhone' | 'status' | 'addedWithinDays';
    patch: Patch;
  }> = [
    { key: 'website', label: 'website', patch: { website: 'none' } },
    { key: 'rating[gte]', label: 'rating', patch: { 'rating[gte]': 4 } },
    { key: 'reviews[lte]', label: 'reviews', patch: { 'reviews[lte]': 20 } },
    { key: 'hasEmail', label: 'hasEmail', patch: { hasEmail: 'true' } },
    { key: 'hasPhone', label: 'hasPhone', patch: { hasPhone: 'true' } },
    { key: 'status', label: 'status', patch: { status: ['new'] } },
    { key: 'addedWithinDays', label: 'addedWithinDays', patch: { addedWithinDays: 7 } },
  ];
  const isSet = (key: FilterKey) => state[key] !== null && state[key] !== undefined;

  return (
    <section className="flex flex-wrap items-center gap-2" aria-label={t('label')}>
      {chips}
      {categories.length === 0 ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" size="sm" variant="ghost">
              <PlusIcon aria-hidden />
              {t('addCategory')}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80">
            <CategoryPicker
              tree={picker}
              value={[]}
              onChange={(value) => set({ category: value.length > 0 ? value : null })}
              labels={pickerLabels}
            />
          </PopoverContent>
        </Popover>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="ghost">
            <PlusIcon aria-hidden />
            {t('addFilter')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {missing
            .filter((m) => !isSet(m.key))
            .map((m) => (
              <DropdownMenuItem key={m.key} onSelect={() => set(m.patch)}>
                {t(`add.${m.label}`)}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </section>
  );
}
