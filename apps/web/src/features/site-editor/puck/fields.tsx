'use client';

import {
  CTA_KINDS,
  type CtaAction,
  LIMITS,
  type LocalizedText,
  parseRichText,
  RESERVED_SLUGS,
  type SiteLocale,
} from '@bf/site-schema';
import { Button } from '@bf/ui/components/button';
import { Input } from '@bf/ui/components/input';
import { Textarea } from '@bf/ui/components/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@bf/ui/components/tooltip';
import { FieldLabel } from '@puckeditor/core';
import { ArrowDownIcon, ArrowUpIcon, LockIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { AssetPicker } from '../assets/asset-picker.tsx';
import { useSiteEditor } from '../context.tsx';
import type { FieldSpec } from './field-registry.ts';

// The editor's own fields (BF-037), for what Puck's built-in fields cannot say: texts in the site's languages with
// their limits, the rich-text subset, the site's images, actions, and facts (read-only until BF-040). Each takes
// Puck's custom-field props (value, onChange, readOnly) and reads the site from the editor context.

export interface CustomFieldProps<Value> {
  readonly label: string;
  readonly id: string;
  readonly value: Value;
  readonly onChange: (value: Value) => void;
  readonly readOnly?: boolean | undefined;
  /** What to write there (the editor's help for this field). */
  readonly help?: string | undefined;
}

type TextSpec = Extract<FieldSpec, { kind: 'localizedText' | 'richText' }>;

/** A character counter against the field's limit (the schema's), red past it. */
function Counter({
  id,
  length,
  max,
}: {
  readonly id?: string;
  readonly length: number;
  readonly max: number;
}) {
  return (
    <span id={id} className={length > max ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
      {length}/{max}
    </span>
  );
}

/** A field's help: what to write there. */
function FieldHelp({ text }: { readonly text: string }) {
  return <p className="text-muted-foreground mb-1 text-xs">{text}</p>;
}

/** A text in the site's languages: the language being written, or all of them; missing translations flagged. */
export function LocalizedTextField({
  spec,
  label,
  id,
  value,
  onChange,
  readOnly,
  help,
}: CustomFieldProps<LocalizedText | undefined> & { readonly spec: TextSpec }) {
  const t = useTranslations('siteEditor.fields');
  const editor = useSiteEditor();
  const [all, setAll] = React.useState(false);
  const text = value ?? {};
  const shown: readonly SiteLocale[] = all ? editor.spec.locales : [editor.locale];
  const missing = editor.spec.locales.filter((locale) => !text[locale]);
  const set = (locale: SiteLocale, next: string) => {
    const copy: LocalizedText = { ...text };
    // A blank text is no text (the schema trims it): the translation is missing.
    if (next.trim() === '') delete copy[locale];
    else copy[locale] = next;
    onChange(Object.keys(copy).length > 0 || !spec.optional ? copy : undefined);
  };
  const multiline = spec.kind === 'richText' || spec.multiline;
  return (
    <FieldLabel label={label} el="div" readOnly={readOnly ?? false}>
      {help ? <FieldHelp text={help} /> : null}
      <div className="flex flex-col gap-2">
        {shown.map((locale) => {
          const inputId = `${id}-${locale}`;
          const current = text[locale] ?? '';
          const common = {
            id: inputId,
            value: current,
            readOnly,
            maxLength: spec.max,
            lang: locale,
            'aria-label': `${label} (${locale.toUpperCase()})`,
            'aria-invalid': !current && editor.spec.locales.includes(locale) ? true : undefined,
            'aria-describedby': `${inputId}-count${current ? '' : ` ${inputId}-missing`}`,
            onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
              set(locale, event.target.value),
          };
          return (
            <div key={locale} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={inputId} className="text-muted-foreground text-xs uppercase">
                  {locale}
                  {current ? null : (
                    <span id={`${inputId}-missing`} className="text-destructive ml-1 normal-case">
                      {t('missing')}
                    </span>
                  )}
                </label>
                <Counter id={`${inputId}-count`} length={current.length} max={spec.max} />
              </div>
              {spec.kind === 'richText' && !readOnly ? (
                <RichTextToolbar targetId={inputId} value={current} onChange={(next) => set(locale, next)} />
              ) : null}
              {multiline ? (
                <Textarea rows={spec.kind === 'richText' ? 8 : 3} {...common} />
              ) : (
                <Input {...common} />
              )}
              {spec.kind === 'richText' ? <RichTextProblems text={current} /> : null}
            </div>
          );
        })}
        {editor.spec.locales.length > 1 ? (
          <button
            type="button"
            className="text-muted-foreground self-start text-xs underline"
            aria-pressed={all}
            onClick={() => setAll((open) => !open)}
          >
            {all ? t('oneLocale') : t('allLocales', { missing: missing.length })}
          </button>
        ) : null}
      </div>
    </FieldLabel>
  );
}

/** Bold, italic, a list and a link to one of the site's pages: the rich-text subset, nothing else. */
function RichTextToolbar({
  targetId,
  value,
  onChange,
}: {
  readonly targetId: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
}) {
  const t = useTranslations('siteEditor.fields');
  const { spec } = useSiteEditor();
  const wrap = (before: string, after = before) => {
    const area = document.getElementById(targetId) as HTMLTextAreaElement | null;
    const start = area?.selectionStart ?? value.length;
    const end = area?.selectionEnd ?? value.length;
    onChange(`${value.slice(0, start)}${before}${value.slice(start, end)}${after}${value.slice(end)}`);
  };
  const line = () => {
    const area = document.getElementById(targetId) as HTMLTextAreaElement | null;
    const start = area?.selectionStart ?? value.length;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    onChange(`${value.slice(0, lineStart)}- ${value.slice(lineStart)}`);
  };
  return (
    <div className="flex flex-wrap gap-1" role="toolbar" aria-label={t('formatting')}>
      <Button type="button" size="sm" variant="outline" onClick={() => wrap('**')}>
        {t('bold')}
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={() => wrap('*')}>
        {t('italic')}
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={line}>
        {t('list')}
      </Button>
      <select
        className="border-input h-8 rounded-md border bg-transparent px-2 text-xs"
        aria-label={t('linkToPage')}
        value=""
        onChange={(event) => {
          if (event.target.value) wrap('[', `](page:${event.target.value})`);
        }}
      >
        <option value="">{t('linkToPage')}</option>
        {spec.pages.map((page) => (
          <option key={page.id} value={page.id}>
            {page.title[spec.defaultLocale] ?? page.id}
          </option>
        ))}
      </select>
    </div>
  );
}

/** What the renderer would not render as formatting (it shows it as plain text). */
function RichTextProblems({ text }: { readonly text: string }) {
  const problems = React.useMemo(() => (text ? parseRichText(text).problems : []), [text]);
  if (problems.length === 0) return null;
  return (
    <ul className="text-destructive list-disc pl-4 text-xs">
      {problems.slice(0, 3).map((problem) => (
        <li key={problem}>{problem}</li>
      ))}
    </ul>
  );
}

/** A single-line text that is not translated (a name, an author, a currency), within its limit. */
export function PlainTextField({
  max,
  label,
  id,
  value,
  onChange,
  readOnly,
  help,
}: CustomFieldProps<string | undefined> & { readonly max: number | undefined }) {
  const current = value ?? '';
  return (
    <FieldLabel label={label} el="div" readOnly={readOnly ?? false}>
      {help ? <FieldHelp text={help} /> : null}
      <div className="flex flex-col gap-1">
        <Input
          id={id}
          aria-label={label}
          value={current}
          readOnly={readOnly}
          maxLength={max}
          onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
        />
        {max ? <Counter length={current.length} max={max} /> : null}
      </div>
    </FieldLabel>
  );
}

/** One of the site's images (none, if the prop is optional), chosen in the image picker. */
export function AssetField({
  label,
  id,
  value,
  onChange,
  readOnly,
  help,
  optional,
}: CustomFieldProps<string | undefined> & { readonly optional: boolean }) {
  const t = useTranslations('siteEditor.fields');
  const { spec, locale } = useSiteEditor();
  const [picking, setPicking] = React.useState(false);
  const selected = spec.assets.find((asset) => asset.id === value);
  const name = selected
    ? (selected.alt[locale] ?? selected.alt[spec.defaultLocale] ?? selected.id)
    : undefined;
  return (
    <FieldLabel label={label} el="div" readOnly={readOnly ?? false}>
      {help ? <FieldHelp text={help} /> : null}
      <div className="flex flex-col gap-2">
        {selected ? (
          <img
            src={selected.url}
            alt={selected.alt[locale] ?? ''}
            width={selected.width}
            height={selected.height}
            className="h-24 w-full rounded object-cover"
          />
        ) : (
          <span className="text-muted-foreground text-xs">{t('noImage')}</span>
        )}
        {name ? <span className="truncate text-xs">{name}</span> : null}
        {readOnly ? null : (
          <div className="flex gap-1">
            <Button id={id} type="button" size="sm" variant="outline" onClick={() => setPicking(true)}>
              {selected ? t('changeImage', { name: label }) : t('chooseImage', { name: label })}
            </Button>
            {optional && selected ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => onChange(undefined)}>
                {t('removeImage')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {picking ? (
        <AssetPicker
          open
          onOpenChange={setPicking}
          kinds={['image', 'logo']}
          onPick={(assetId) => onChange(assetId)}
        />
      ) : null}
    </FieldLabel>
  );
}

/** Several of the site's images, in order, within the block's bounds. */
export function AssetListField({
  label,
  id,
  value,
  onChange,
  readOnly,
  help,
  min,
  max,
}: CustomFieldProps<readonly string[] | undefined> & {
  readonly min: number | undefined;
  readonly max: number | undefined;
}) {
  const t = useTranslations('siteEditor.fields');
  const { spec, locale } = useSiteEditor();
  const [picking, setPicking] = React.useState(false);
  const ids = value ?? [];
  const byId = new Map(spec.assets.map((asset) => [asset.id, asset]));
  const move = (from: number, to: number) => {
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    if (moved) next.splice(to, 0, moved);
    onChange(next);
  };
  return (
    <FieldLabel label={label} el="div" readOnly={readOnly ?? false}>
      {help ? <FieldHelp text={help} /> : null}
      <div className="flex flex-col gap-2">
        <ol className="flex flex-col gap-1">
          {ids.map((assetId, index) => {
            const asset = byId.get(assetId);
            const name = asset?.alt[locale] ?? assetId;
            // An image may be listed twice (stored data): its key counts earlier copies, so it stays stable when a
            // row moves (focus follows the moved image) and unique when an id repeats.
            const copy = ids.slice(0, index).filter((other) => other === assetId).length;
            return (
              <li key={`${assetId}#${copy}`} className="flex items-center gap-1 text-sm">
                {asset ? (
                  <img src={asset.url} alt="" className="size-8 shrink-0 rounded object-cover" />
                ) : null}
                <span className="flex-1 truncate">{name}</span>
                {readOnly ? null : (
                  <>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={t('moveUp', { name })}
                      disabled={index === 0}
                      onClick={() => move(index, index - 1)}
                    >
                      <ArrowUpIcon aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={t('moveDown', { name })}
                      disabled={index === ids.length - 1}
                      onClick={() => move(index, index + 1)}
                    >
                      <ArrowDownIcon aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={t('remove', { name })}
                      disabled={ids.length <= (min ?? 0)}
                      onClick={() => onChange(ids.filter((_, at) => at !== index))}
                    >
                      <XIcon aria-hidden />
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ol>
        {readOnly || ids.length >= (max ?? Number.POSITIVE_INFINITY) ? null : (
          <Button id={id} type="button" size="sm" variant="outline" onClick={() => setPicking(true)}>
            {t('addImage')}
          </Button>
        )}
      </div>
      {picking ? (
        <AssetPicker
          open
          onOpenChange={setPicking}
          kinds={['image']}
          onPick={(assetId) => {
            if (!ids.includes(assetId)) onChange([...ids, assetId]);
          }}
        />
      ) : null}
    </FieldLabel>
  );
}

const HTTPS = /^https:\/\/[^\s/?#]+\.[^\s/?#]+/;

/** A button: what it does (the kinds that use the contact facts need nothing else), its label, its target. */
export function CtaField({
  label,
  id,
  value,
  onChange,
  readOnly,
  help,
  optional,
}: CustomFieldProps<CtaAction | undefined> & { readonly optional: boolean }) {
  const t = useTranslations('siteEditor.fields');
  const { spec } = useSiteEditor();
  const kind = value?.kind ?? '';
  const labelText = value?.label ?? {};
  const choose = (next: string) => {
    if (next === '') return onChange(undefined);
    // A new button is labelled with its action until someone writes a better label (an empty label cannot be saved).
    const label =
      Object.keys(labelText).length > 0 ? labelText : { [spec.defaultLocale]: t(`cta.${next}` as never) };
    if (next === 'page') return onChange({ kind: 'page', label, pageId: spec.pages[0]?.id ?? 'home' });
    if (next === 'url') return onChange({ kind: 'url', label, url: 'https://' });
    onChange({ kind: next as 'call', label });
  };
  return (
    <FieldLabel label={label} el="div" readOnly={readOnly ?? false}>
      {help ? <FieldHelp text={help} /> : null}
      <div className="flex flex-col gap-2 rounded-md border p-2">
        <select
          id={id}
          aria-label={t('ctaKind')}
          className="border-input h-9 rounded-md border bg-transparent px-2 text-sm"
          value={kind}
          disabled={readOnly}
          onChange={(event) => choose(event.target.value)}
        >
          {optional || !value ? <option value="">{t('noButton')}</option> : null}
          {CTA_KINDS.map((option) => (
            <option key={option} value={option}>
              {t(`cta.${option}`)}
            </option>
          ))}
        </select>
        {value ? (
          <>
            <LocalizedTextField
              spec={{
                key: 'label',
                kind: 'localizedText',
                max: LIMITS.ctaLabel.max,
                multiline: false,
                optional: false,
                help: undefined,
              }}
              label={t('ctaLabel')}
              id={`${id}-label`}
              value={value.label}
              readOnly={readOnly}
              onChange={(next) => onChange({ ...value, label: next ?? {} })}
            />
            {value.kind === 'page' ? (
              <select
                aria-label={t('ctaPage')}
                className="border-input h-9 rounded-md border bg-transparent px-2 text-sm"
                value={value.pageId}
                disabled={readOnly}
                onChange={(event) => onChange({ ...value, pageId: event.target.value })}
              >
                {spec.pages.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.title[spec.defaultLocale] ?? page.id}
                  </option>
                ))}
              </select>
            ) : null}
            {value.kind === 'url' ? (
              <div className="flex flex-col gap-1">
                <Input
                  aria-label={t('ctaUrl')}
                  value={value.url}
                  readOnly={readOnly}
                  inputMode="url"
                  aria-invalid={!HTTPS.test(value.url)}
                  aria-describedby={`${id}-url-help`}
                  onChange={(event) => onChange({ ...value, url: event.target.value })}
                />
                <span
                  id={`${id}-url-help`}
                  className={
                    HTTPS.test(value.url) ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'
                  }
                >
                  {t('ctaUrlHelp')}
                </span>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </FieldLabel>
  );
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A page's address: kebab-case, unique, not reserved; the home page's ("") never changes. */
export function SlugField({
  label,
  id,
  value,
  onChange,
  readOnly,
  help,
}: CustomFieldProps<string | undefined>) {
  const t = useTranslations('siteEditor.fields');
  const { spec, pageId } = useSiteEditor();
  const home = spec.pages.find((page) => page.id === pageId)?.slug === '';
  const current = value ?? '';
  const taken = spec.pages.some((page) => page.id !== pageId && page.slug === current);
  const problem = home
    ? undefined
    : !SLUG.test(current)
      ? t('slugFormat')
      : RESERVED_SLUGS.includes(current)
        ? t('slugReserved')
        : taken
          ? t('slugTaken')
          : undefined;
  return (
    <FieldLabel label={label} el="div" readOnly={readOnly || home}>
      {help ? <FieldHelp text={help} /> : null}
      <div className="flex flex-col gap-1">
        <Input
          id={id}
          aria-label={label}
          value={home ? '/' : current}
          readOnly={readOnly || home}
          aria-invalid={problem ? true : undefined}
          aria-describedby={`${id}-help`}
          onChange={(event) => onChange(event.target.value.toLowerCase())}
        />
        <span
          id={`${id}-help`}
          className={problem ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
        >
          {home ? t('slugHome') : (problem ?? t('slugHelp'))}
        </span>
      </div>
    </FieldLabel>
  );
}

/** A fact the item rests on: shown, not edited, until the fact registry exists (BF-040). */
export function FactField({ label, value, help }: CustomFieldProps<string | readonly string[] | undefined>) {
  const t = useTranslations('siteEditor.fields');
  const ids = value === undefined ? [] : typeof value === 'string' ? [value] : value;
  return (
    <FieldLabel label={label} el="div" readOnly>
      {help ? <FieldHelp text={help} /> : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="text-muted-foreground flex items-center gap-1 text-left text-xs">
            <LockIcon aria-hidden className="size-3" />
            {ids.length > 0 ? ids.join(', ') : t('noFact')}
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('factsLater')}</TooltipContent>
      </Tooltip>
    </FieldLabel>
  );
}

/** Several values of a list (tags), as checkboxes. */
export function EnumListField({
  label,
  id,
  value,
  onChange,
  readOnly,
  help,
  options,
  optionLabel,
}: CustomFieldProps<readonly string[] | undefined> & {
  readonly options: readonly string[];
  readonly optionLabel: (option: string) => string;
}) {
  const chosen = new Set(value ?? []);
  return (
    <FieldLabel label={label} el="div" readOnly={readOnly ?? false}>
      {help ? <FieldHelp text={help} /> : null}
      <fieldset className="flex flex-wrap gap-x-3 gap-y-1" id={id}>
        <legend className="sr-only">{label}</legend>
        {options.map((option) => (
          <label key={option} className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={chosen.has(option)}
              disabled={readOnly}
              onChange={(event) => {
                const next = new Set(chosen);
                if (event.target.checked) next.add(option);
                else next.delete(option);
                onChange(options.filter((entry) => next.has(entry)));
              }}
            />
            {optionLabel(option)}
          </label>
        ))}
      </fieldset>
    </FieldLabel>
  );
}
