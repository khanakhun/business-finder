'use client';

import {
  CONTRAST_PAIRS,
  type CtaAction,
  contrastRatio,
  FONT_PAIRS,
  type Layout,
  LIMITS,
  type LocalizedText,
  type Navigation,
  type Palette,
  SITE_LOCALES,
  type SiteLocale,
  type SiteSpec,
  suggestColor,
  THEME_STYLES,
  type Theme,
} from '@bf/site-schema';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Input } from '@bf/ui/components/input';
import { ArrowDownIcon, ArrowUpIcon, LockIcon, Redo2Icon, Undo2Icon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useSiteEditor, useSiteEditorActions } from '../context.tsx';
import { CtaField } from '../puck/fields.tsx';

// The site's own settings (BF-037), beside the canvas: theme, menu, header and footer, languages, search texts and
// settings, each change a BF-033 operation (undoable here); the contact details are facts, shown not edited.

/** A value with its texts trimmed (as the schema stores them), for comparing what is typed with what is saved. */
function normalized(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalized(entry)]));
  return value;
}

/**
 * A value edited locally and committed when the person pauses or leaves the field (one change, not one per key).
 * The editor flushes it before any change or save (`register`), so nothing typed is lost; a new value from outside
 * replaces the local one only when it says something else (a trailing space being typed stays).
 */
function useCommitted<T>(value: T, commit: (next: T) => void, delay = 700) {
  const { register } = useSiteEditorActions();
  const [draft, setDraft] = React.useState(value);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = React.useRef(false);
  const latest = React.useRef({ draft, value, commit });
  latest.current = { draft, value, commit };
  React.useEffect(() => {
    const local = latest.current.draft;
    if (pending.current) return;
    if (JSON.stringify(normalized(local)) !== JSON.stringify(normalized(value))) setDraft(value);
  }, [value]);
  const flush = React.useCallback(() => {
    clearTimeout(timer.current);
    if (!pending.current) return;
    pending.current = false;
    const { draft: next, value: current, commit: send } = latest.current;
    if (JSON.stringify(normalized(next)) !== JSON.stringify(normalized(current))) send(next);
  }, []);
  React.useEffect(() => register(flush), [register, flush]);
  // Leaving (the panel closed) commits what was typed.
  React.useEffect(() => flush, [flush]);
  const update = (next: T) => {
    setDraft(next);
    latest.current = { ...latest.current, draft: next };
    pending.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, delay);
  };
  return { draft, update, flush };
}

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b px-4 py-4" aria-label={title}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Select<T extends string>({
  label,
  value,
  options,
  optionLabel,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly T[];
  readonly optionLabel: (option: T) => string;
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean | undefined;
}) {
  const id = React.useId();
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="border-input h-8 max-w-[60%] rounded-md border bg-transparent px-2"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean | undefined;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      {label}
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

/** A text in the site's languages, in the language being written; committed on a pause or on leaving. */
function TextInLocale({
  label,
  value,
  max,
  optional,
  onCommit,
  disabled,
}: {
  readonly label: string;
  readonly value: LocalizedText | undefined;
  readonly max: number;
  readonly optional?: boolean;
  readonly onCommit: (next: LocalizedText | undefined) => void;
  readonly disabled?: boolean | undefined;
}) {
  const { locale } = useSiteEditor();
  const id = React.useId();
  const { draft, update, flush } = useCommitted(value, onCommit);
  const current = draft?.[locale] ?? '';
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id}>
        {label} <span className="text-muted-foreground text-xs uppercase">{locale}</span>
      </label>
      <Input
        id={id}
        value={current}
        maxLength={max}
        readOnly={disabled}
        onBlur={flush}
        onChange={(event) => {
          const next: LocalizedText = { ...(draft ?? {}) };
          if (event.target.value.trim() === '') delete next[locale];
          else next[locale] = event.target.value;
          update(Object.keys(next).length > 0 || !optional ? next : undefined);
        }}
      />
    </div>
  );
}

/** Per-locale `updateText` operations from `before` to `after` at `path`. */
function textChanges(path: (string | number)[], before: LocalizedText, after: LocalizedText | undefined) {
  const next = after ?? {};
  return [...new Set([...Object.keys(before), ...Object.keys(next)])]
    .filter((locale) => before[locale as SiteLocale] !== next[locale as SiteLocale])
    .map((locale) => ({
      op: 'updateText' as const,
      path,
      locale: locale as SiteLocale,
      value: next[locale as SiteLocale]?.trim() || null,
    }));
}

function ThemeSection({ spec, readOnly }: { readonly spec: SiteSpec; readonly readOnly: boolean }) {
  const t = useTranslations('siteEditor.settings');
  const { change } = useSiteEditorActions();
  const theme = spec.theme;
  const set = (next: Partial<Theme>) => change({ op: 'setTheme', theme: { ...theme, ...next } });
  const setColor = (key: keyof Palette, value: string) =>
    set({ palette: { ...theme.palette, [key]: value.toLowerCase() } });
  const problems = CONTRAST_PAIRS.flatMap(([fg, backgrounds, ratio]) => {
    const color = theme.palette[fg];
    if (!color) return [];
    const against = backgrounds.map((bg) => theme.palette[bg] as string);
    const worst = Math.min(...against.map((bg) => contrastRatio(color, bg)));
    if (worst >= ratio) return [];
    return [{ fg, ratio, worst, fix: suggestColor(color, against, ratio) }];
  });
  return (
    <Section title={t('theme')}>
      <Select
        label={t('style')}
        value={theme.style}
        options={THEME_STYLES}
        optionLabel={(style) => t(`styles.${style}` as never)}
        disabled={readOnly}
        onChange={(style) => set({ style })}
      />
      <Select
        label={t('fonts')}
        value={theme.typography.pairId}
        options={FONT_PAIRS.map((pair) => pair.id)}
        optionLabel={(id) => {
          const pair = FONT_PAIRS.find((candidate) => candidate.id === id);
          return pair ? `${pair.heading.family} / ${pair.body.family}` : id;
        }}
        disabled={readOnly}
        onChange={(pairId) => set({ typography: { pairId } })}
      />
      <Select
        label={t('radius')}
        value={theme.radius}
        options={['none', 'sm', 'md', 'lg', 'full'] as const}
        optionLabel={(radius) => t(`radii.${radius}` as never)}
        disabled={readOnly}
        onChange={(radius) => set({ radius })}
      />
      <Select
        label={t('density')}
        value={theme.density}
        options={['compact', 'comfortable', 'airy'] as const}
        optionLabel={(density) => t(`densities.${density}` as never)}
        disabled={readOnly}
        onChange={(density) => set({ density })}
      />
      <Select
        label={t('imageTreatment')}
        value={theme.imageTreatment}
        options={['plain', 'rounded', 'framed'] as const}
        optionLabel={(treatment) => t(`treatments.${treatment}` as never)}
        disabled={readOnly}
        onChange={(imageTreatment) => set({ imageTreatment })}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm">{t('palette')}</legend>
        {(Object.keys(theme.palette) as (keyof Palette)[]).map((key) => (
          <ColorInput
            key={key}
            label={t(`colors.${key}` as never)}
            value={theme.palette[key] as string}
            disabled={readOnly}
            onCommit={(value) => setColor(key, value)}
          />
        ))}
      </fieldset>
      {problems.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label={t('contrastProblems')}>
          {problems.map(({ fg, ratio, worst, fix }) => (
            <li key={fg} className="text-destructive flex flex-wrap items-center gap-2 text-xs">
              {t('contrast', { color: t(`colors.${fg}` as never), ratio: worst.toFixed(2), needed: ratio })}
              {fix && !readOnly ? (
                <Button type="button" size="sm" variant="outline" onClick={() => setColor(fg, fix)}>
                  <span aria-hidden className="size-3 rounded-sm border" style={{ background: fix }} />
                  {t('useColor', { color: fix })}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function ColorInput({
  label,
  value,
  disabled,
  onCommit,
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onCommit: (value: string) => void;
}) {
  const id = React.useId();
  const { draft, update, flush } = useCommitted(value, (next) => {
    if (/^#[0-9a-fA-F]{6}$/.test(next)) onCommit(next);
  });
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <label htmlFor={id}>{label}</label>
      <span className="flex items-center gap-1">
        <input
          type="color"
          aria-label={label}
          value={/^#[0-9a-fA-F]{6}$/.test(draft) ? draft : value}
          disabled={disabled}
          onBlur={flush}
          onChange={(event) => update(event.target.value)}
        />
        <Input
          id={id}
          className="h-8 w-24 font-mono text-xs"
          value={draft}
          readOnly={disabled}
          onBlur={flush}
          onChange={(event) => update(event.target.value)}
        />
      </span>
    </div>
  );
}

function NavigationSection({ spec, readOnly }: { readonly spec: SiteSpec; readonly readOnly: boolean }) {
  const t = useTranslations('siteEditor.settings');
  const { change } = useSiteEditorActions();
  const items = spec.navigation.items;
  const set = (next: Navigation['items']) => change({ op: 'setNavigation', navigation: { items: next } });
  const move = (from: number, to: number) => {
    const next = [...items];
    const [moved] = next.splice(from, 1);
    if (moved) next.splice(to, 0, moved);
    set(next);
  };
  const missing = spec.pages.filter((page) => !items.some((item) => item.pageId === page.id));
  const pageName = (pageId: string) => {
    const page = spec.pages.find((candidate) => candidate.id === pageId);
    return page?.title[spec.defaultLocale] ?? pageId;
  };
  return (
    <Section title={t('navigation')}>
      <ol className="flex flex-col gap-3">
        {items.map((item, index) => (
          <li key={item.pageId} className="flex flex-col gap-1 rounded-md border p-2">
            <div className="flex items-center gap-1 text-xs">
              <span className="text-muted-foreground flex-1">{pageName(item.pageId)}</span>
              {readOnly ? null : (
                <>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('moveUp', { name: pageName(item.pageId) })}
                    disabled={index === 0}
                    onClick={() => move(index, index - 1)}
                  >
                    <ArrowUpIcon aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('moveDown', { name: pageName(item.pageId) })}
                    disabled={index === items.length - 1}
                    onClick={() => move(index, index + 1)}
                  >
                    <ArrowDownIcon aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('removeFromMenu', { name: pageName(item.pageId) })}
                    onClick={() => set(items.filter((_, at) => at !== index))}
                  >
                    <XIcon aria-hidden />
                  </Button>
                </>
              )}
            </div>
            <TextInLocale
              label={t('menuLabel')}
              value={item.label}
              max={LIMITS.navLabel.max}
              disabled={readOnly}
              onCommit={(label) =>
                set(
                  items.map((other, at) =>
                    at === index ? { ...other, label: label ?? other.label } : other,
                  ),
                )
              }
            />
          </li>
        ))}
      </ol>
      {readOnly || items.length >= 7 || missing.length === 0 ? (
        items.length >= 7 ? (
          <p className="text-muted-foreground text-xs">{t('menuFull')}</p>
        ) : null
      ) : (
        <select
          aria-label={t('addToMenu')}
          className="border-input h-8 rounded-md border bg-transparent px-2 text-sm"
          value=""
          onChange={(event) => {
            const page = spec.pages.find((candidate) => candidate.id === event.target.value);
            if (page) set([...items, { pageId: page.id, label: { ...page.title } }]);
          }}
        >
          <option value="">{t('addToMenu')}</option>
          {missing.map((page) => (
            <option key={page.id} value={page.id}>
              {pageName(page.id)}
            </option>
          ))}
        </select>
      )}
    </Section>
  );
}

function LayoutSection({ spec, readOnly }: { readonly spec: SiteSpec; readonly readOnly: boolean }) {
  const t = useTranslations('siteEditor.settings');
  const { change } = useSiteEditorActions();
  const { header, footer } = spec.layout;
  const set = (next: Partial<Layout>) => change({ op: 'setLayout', layout: { ...spec.layout, ...next } });
  const logos = spec.assets.filter((asset) => asset.kind === 'logo');
  const cta = useCommitted<CtaAction | undefined>(header.cta, (next) =>
    set({ header: next ? { ...header, cta: next } : { ...header, showCta: false, cta: undefined } }),
  );
  return (
    <Section title={t('headerFooter')}>
      <Select
        label={t('headerVariant')}
        value={header.variant}
        options={['simple', 'centered', 'transparent'] as const}
        optionLabel={(variant) => t(`headerVariants.${variant}` as never)}
        disabled={readOnly}
        onChange={(variant) => set({ header: { ...header, variant } })}
      />
      <Select
        label={t('logo')}
        value={header.logoAssetId ?? ''}
        options={['', ...logos.map((asset) => asset.id)]}
        optionLabel={(id) =>
          id === '' ? t('noLogo') : (logos.find((asset) => asset.id === id)?.alt[spec.defaultLocale] ?? id)
        }
        disabled={readOnly}
        onChange={(id) => set({ header: { ...header, logoAssetId: id || undefined } })}
      />
      <Toggle
        label={t('headerButton')}
        checked={header.showCta}
        disabled={readOnly}
        onChange={(showCta) => set({ header: { ...header, showCta } })}
      />
      {header.showCta ? (
        <CtaField
          label={t('headerButton')}
          id="header-cta"
          value={cta.draft}
          optional
          onChange={cta.update}
          readOnly={readOnly}
        />
      ) : null}
      <Select
        label={t('footerVariant')}
        value={footer.variant}
        options={['simple', 'columns'] as const}
        optionLabel={(variant) => t(`footerVariants.${variant}` as never)}
        disabled={readOnly}
        onChange={(variant) => set({ footer: { ...footer, variant } })}
      />
      <Toggle
        label={t('showSocials')}
        checked={footer.showSocials}
        disabled={readOnly || !spec.contact.socials?.length}
        onChange={(showSocials) => set({ footer: { ...footer, showSocials } })}
      />
      <Toggle
        label={t('showHours')}
        checked={footer.showHours}
        disabled={readOnly || !spec.contact.hours}
        onChange={(showHours) => set({ footer: { ...footer, showHours } })}
      />
      <TextInLocale
        label={t('tagline')}
        value={footer.tagline}
        max={LIMITS.tagline.max}
        optional
        disabled={readOnly}
        onCommit={(tagline) => set({ footer: { ...footer, tagline } })}
      />
    </Section>
  );
}

function LocalesSection({ spec, readOnly }: { readonly spec: SiteSpec; readonly readOnly: boolean }) {
  const t = useTranslations('siteEditor.settings');
  const { change } = useSiteEditorActions();
  const set = (locales: readonly SiteLocale[], defaultLocale: SiteLocale) =>
    change({ op: 'setLocales', locales: [...locales], defaultLocale });
  const addable = SITE_LOCALES.filter((locale) => !spec.locales.includes(locale));
  return (
    <Section title={t('languages')}>
      <ul className="flex flex-col gap-2">
        {spec.locales.map((locale) => (
          <li key={locale} className="flex items-center gap-2 text-sm">
            <span className="flex-1 uppercase">{locale}</span>
            {locale === spec.defaultLocale ? (
              <Badge variant="secondary">{t('defaultLanguage')}</Badge>
            ) : readOnly ? null : (
              <>
                <Button type="button" size="sm" variant="ghost" onClick={() => set(spec.locales, locale)}>
                  {t('makeDefault')}
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t('removeLanguage', { locale: locale.toUpperCase() })}
                  onClick={() => {
                    if (window.confirm(t('removeLanguageConfirm', { locale: locale.toUpperCase() })))
                      set(
                        spec.locales.filter((other) => other !== locale),
                        spec.defaultLocale,
                      );
                  }}
                >
                  <XIcon aria-hidden />
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {readOnly || addable.length === 0 || spec.locales.length >= 4 ? null : (
        <select
          aria-label={t('addLanguage')}
          className="border-input h-8 rounded-md border bg-transparent px-2 text-sm"
          value=""
          onChange={(event) => {
            if (event.target.value)
              set([...spec.locales, event.target.value as SiteLocale], spec.defaultLocale);
          }}
        >
          <option value="">{t('addLanguage')}</option>
          {addable.map((locale) => (
            <option key={locale} value={locale}>
              {locale.toUpperCase()}
            </option>
          ))}
        </select>
      )}
      <p className="text-muted-foreground text-xs">{t('languagesHelp')}</p>
    </Section>
  );
}

function SearchSection({ spec, readOnly }: { readonly spec: SiteSpec; readonly readOnly: boolean }) {
  const t = useTranslations('siteEditor.settings');
  const { change } = useSiteEditorActions();
  const commit = (key: 'title' | 'description') => (next: LocalizedText | undefined) => {
    const ops = textChanges(['seo', key], spec.seo[key], next);
    if (ops.length === 1 && ops[0]) change(ops[0]);
    else if (ops.length > 1) change({ op: 'batch', ops });
  };
  return (
    <Section title={t('search')}>
      <TextInLocale
        label={t('siteTitle')}
        value={spec.seo.title}
        max={LIMITS.siteTitle.max}
        disabled={readOnly}
        onCommit={commit('title')}
      />
      <TextInLocale
        label={t('siteDescription')}
        value={spec.seo.description}
        max={LIMITS.siteDescription.max}
        disabled={readOnly}
        onCommit={commit('description')}
      />
    </Section>
  );
}

function SettingsSection({ spec, readOnly }: { readonly spec: SiteSpec; readonly readOnly: boolean }) {
  const t = useTranslations('siteEditor.settings');
  const { change } = useSiteEditorActions();
  const settings = spec.settings;
  return (
    <Section title={t('settings')}>
      <Select
        label={t('analytics')}
        value={settings.analytics}
        options={['cookieless', 'none'] as const}
        optionLabel={(mode) => t(`analyticsModes.${mode}` as never)}
        disabled={readOnly}
        onChange={(analytics) => change({ op: 'setSettings', settings: { ...settings, analytics } })}
      />
      <Toggle
        label={t('contactForm')}
        checked={settings.contactForm.enabled}
        disabled={readOnly}
        onChange={(enabled) =>
          change({ op: 'setSettings', settings: { ...settings, contactForm: { enabled } } })
        }
      />
      <p className="text-muted-foreground flex items-center gap-1 text-xs">
        <LockIcon aria-hidden className="size-3" />
        {t('previewLocked')}
      </p>
    </Section>
  );
}

function ContactSection({ spec }: { readonly spec: SiteSpec }) {
  const t = useTranslations('siteEditor.settings');
  const { contact } = spec;
  const rows: [string, string | undefined][] = [
    [t('phone'), contact.phone?.value],
    [t('email'), contact.email?.value],
    [t('whatsapp'), contact.whatsapp?.value],
    [
      t('address'),
      contact.address
        ? [contact.address.street, contact.address.locality].filter(Boolean).join(', ')
        : undefined,
    ],
    [t('bookingUrl'), contact.bookingUrl?.value],
  ];
  return (
    <Section title={t('contact')}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate">{value}</dd>
            </React.Fragment>
          ))}
      </dl>
      <p className="text-muted-foreground flex items-center gap-1 text-xs">
        <LockIcon aria-hidden className="size-3" />
        {t('contactFacts')}
      </p>
    </Section>
  );
}

/** The site settings panel (a Puck plugin tab). */
export function SiteSettingsPanel() {
  const t = useTranslations('siteEditor.settings');
  const { spec, readOnly } = useSiteEditor();
  const { undo, redo, canUndo, canRedo } = useSiteEditorActions();
  return (
    <div className="flex flex-col">
      {readOnly ? null : (
        <div className="flex items-center gap-1 border-b px-4 py-2">
          <Button type="button" size="sm" variant="ghost" disabled={!canUndo} onClick={undo}>
            <Undo2Icon aria-hidden />
            {t('undo')}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={!canRedo} onClick={redo}>
            <Redo2Icon aria-hidden />
            {t('redo')}
          </Button>
        </div>
      )}
      <ThemeSection spec={spec} readOnly={readOnly} />
      <NavigationSection spec={spec} readOnly={readOnly} />
      <LayoutSection spec={spec} readOnly={readOnly} />
      <LocalesSection spec={spec} readOnly={readOnly} />
      <SearchSection spec={spec} readOnly={readOnly} />
      <SettingsSection spec={spec} readOnly={readOnly} />
      <ContactSection spec={spec} />
    </div>
  );
}
