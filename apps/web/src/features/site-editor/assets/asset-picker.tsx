'use client';

import {
  type CreateSiteAssetUploadRequest,
  SITE_ASSET_LICENSES,
  SITE_ASSET_MAX_BYTES,
  SITE_ASSET_MIME_TYPES,
  type SiteAsset,
} from '@bf/contracts';
import { type Asset, LIMITS, type LocalizedText, type SiteLocale } from '@bf/site-schema';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { Input } from '@bf/ui/components/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@bf/ui/components/tabs';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { fetchAssets, uploadAsset } from '../api.ts';
import { useSiteEditor, useSiteEditorActions } from '../context.tsx';
import { type FocalPoint, FocalPointPicker } from './focal-point.tsx';
import {
  altFor,
  isRestricted,
  isUsable,
  type Orientation,
  orientationOf,
  specAssetFor,
  toSpecAsset,
} from './spec-asset.ts';

// The image picker (BF-037): the site's images, its library (BF-035 assets: uploaded, collected from the owner's
// site, later stock and AI images from BF-038, which adds a "Find more images" tab here), and uploads with a licence
// declaration and alt texts. A library image becomes one of the site's images (a new element id) when picked.

type Tab = 'site' | 'library' | 'upload';
const CENTER: FocalPoint = { x: 0.5, y: 0.5 };
const POLL_MS = 1_500;
const POLL_TRIES = 40;

/** Alt texts per site language, the default one required. */
function AltInputs({
  locales,
  defaultLocale,
  value,
  onChange,
  idPrefix,
}: {
  readonly locales: readonly SiteLocale[];
  readonly defaultLocale: SiteLocale;
  readonly value: LocalizedText;
  readonly onChange: (value: LocalizedText) => void;
  readonly idPrefix: string;
}) {
  const t = useTranslations('siteEditor.assets');
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{t('alt')}</legend>
      <p className="text-muted-foreground text-xs">{t('altHelp')}</p>
      {locales.map((locale) => (
        <label key={locale} className="flex flex-col gap-1 text-sm" htmlFor={`${idPrefix}-${locale}`}>
          <span>
            {t('altIn', { locale: locale.toUpperCase() })}
            {locale === defaultLocale ? ' *' : ''}
          </span>
          <Input
            id={`${idPrefix}-${locale}`}
            value={value[locale] ?? ''}
            maxLength={LIMITS.alt.max}
            required={locale === defaultLocale}
            onChange={(event) => {
              const next = { ...value };
              if (event.target.value.trim()) next[locale] = event.target.value;
              else delete next[locale];
              onChange(next);
            }}
          />
        </label>
      ))}
    </fieldset>
  );
}

const trimmed = (alt: LocalizedText): LocalizedText =>
  Object.fromEntries(
    Object.entries(alt)
      .map(([locale, text]) => [locale, text?.trim()])
      .filter(([, text]) => text),
  );

function LicenseLine({ asset }: { readonly asset: SiteAsset }) {
  const t = useTranslations('siteEditor.assets');
  const credit = asset.licenseDetails?.attributionText ?? asset.licenseDetails?.author;
  return (
    <span className="text-muted-foreground text-xs">
      {t(`licenses.${asset.license}`)}
      {credit ? ` · ${credit}` : ''}
      {asset.licenseDetails?.provider ? ` · ${asset.licenseDetails.provider}` : ''}
    </span>
  );
}

/**
 * Chooses an image for a field: `onPick` receives the id of one of the site's images (a library image is added to
 * the site first). `kinds` limits the site's own images offered (a gallery takes photos only).
 */
export function AssetPicker({
  open,
  onOpenChange,
  onPick,
  kinds = ['image', 'logo'],
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (assetId: string) => void;
  readonly kinds?: readonly Asset['kind'][];
}) {
  const t = useTranslations('siteEditor.assets');
  const { spec, locale, siteId } = useSiteEditor();
  const { addAsset } = useSiteEditorActions();
  const [tab, setTab] = React.useState<Tab>('site');
  const [library, setLibrary] = React.useState<readonly SiteAsset[] | 'loading' | 'error'>('loading');
  const [query, setQuery] = React.useState('');
  const [license, setLicense] = React.useState<SiteAsset['license'] | ''>('');
  const [orientation, setOrientation] = React.useState<Orientation | ''>('');
  const [chosen, setChosen] = React.useState<SiteAsset | null>(null);
  const [alt, setAlt] = React.useState<LocalizedText>({});
  const [focal, setFocal] = React.useState<FocalPoint>(CENTER);

  const load = React.useCallback(async () => {
    setLibrary('loading');
    try {
      setLibrary(await fetchAssets(siteId));
    } catch {
      setLibrary('error');
    }
  }, [siteId]);
  React.useEffect(() => {
    if (open && tab === 'library') void load();
  }, [open, tab, load]);
  React.useEffect(() => {
    if (!open) setChosen(null);
  }, [open]);

  const choose = (asset: SiteAsset) => {
    setChosen(asset);
    setAlt(altFor(asset, spec.locales));
    setFocal(CENTER);
  };

  /** Puts a library image on the site (or reuses the site's image of the same file) and hands it to the field. */
  const use = (asset: SiteAsset, options: { alt: LocalizedText; focalPoint: FocalPoint }) => {
    const existing = specAssetFor(spec, asset);
    if (existing) {
      onPick(existing.id);
      onOpenChange(false);
      return true;
    }
    const added = toSpecAsset(asset, spec, {
      alt: trimmed(options.alt),
      ...(options.focalPoint === CENTER ? {} : { focalPoint: options.focalPoint }),
    });
    if (!added) return false;
    onPick(added.id);
    addAsset(added);
    onOpenChange(false);
    return true;
  };

  const own = spec.assets.filter((asset) => kinds.includes(asset.kind));
  const items: readonly SiteAsset[] = typeof library === 'string' ? [] : library;
  const needle = query.trim().toLowerCase();
  const shown = items.filter((asset) => {
    if (license && asset.license !== license) return false;
    if (
      orientation &&
      (!asset.width || !asset.height || orientationOf(asset.width, asset.height) !== orientation)
    )
      return false;
    if (!needle) return true;
    const haystack = [
      ...Object.values(asset.alt ?? {}),
      asset.licenseDetails?.author ?? '',
      asset.licenseDetails?.attributionText ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
  const altMissing = !alt[spec.defaultLocale]?.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(next) => setTab(next as Tab)}>
          <TabsList>
            <TabsTrigger value="site">{t('tabs.site')}</TabsTrigger>
            <TabsTrigger value="library">{t('tabs.library')}</TabsTrigger>
            <TabsTrigger value="upload">{t('tabs.upload')}</TabsTrigger>
          </TabsList>
          <TabsContent value="site">
            {own.length === 0 ? (
              <p className="text-muted-foreground py-6 text-sm">{t('noSiteImages')}</p>
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {own.map((asset) => {
                  const name = asset.alt[locale] ?? asset.alt[spec.defaultLocale] ?? asset.id;
                  return (
                    <li key={asset.id}>
                      <button
                        type="button"
                        className="focus-visible:ring-ring flex w-full flex-col gap-1 rounded-md border p-1 text-left outline-none focus-visible:ring-2"
                        onClick={() => {
                          onPick(asset.id);
                          onOpenChange(false);
                        }}
                      >
                        <img src={asset.url} alt="" className="aspect-[4/3] w-full rounded object-cover" />
                        <span className="truncate text-xs">{name}</span>
                        <span className="text-muted-foreground text-xs">
                          {t(`licenses.${asset.license}`)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </TabsContent>
          <TabsContent value="library" className="flex flex-col gap-3">
            {chosen ? (
              <div className="flex flex-col gap-3">
                {chosen.publicUrl ? (
                  <FocalPointPicker
                    src={chosen.publicUrl}
                    alt={alt[locale] ?? ''}
                    value={focal}
                    onChange={setFocal}
                  />
                ) : null}
                <LicenseLine asset={chosen} />
                <AltInputs
                  locales={spec.locales}
                  defaultLocale={spec.defaultLocale}
                  value={alt}
                  onChange={setAlt}
                  idPrefix="library-alt"
                />
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setChosen(null)}>
                    {t('back')}
                  </Button>
                  <Button
                    type="button"
                    disabled={altMissing}
                    onClick={() => use(chosen, { alt, focalPoint: focal })}
                  >
                    {t('useImage')}
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Input
                    type="search"
                    aria-label={t('search')}
                    placeholder={t('search')}
                    className="max-w-56"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <select
                    aria-label={t('filterLicense')}
                    className="border-input h-9 rounded-md border bg-transparent px-2 text-sm"
                    value={license}
                    onChange={(event) => setLicense(event.target.value as SiteAsset['license'] | '')}
                  >
                    <option value="">{t('anyLicense')}</option>
                    {SITE_ASSET_LICENSES.map((value) => (
                      <option key={value} value={value}>
                        {t(`licenses.${value}`)}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={t('filterOrientation')}
                    className="border-input h-9 rounded-md border bg-transparent px-2 text-sm"
                    value={orientation}
                    onChange={(event) => setOrientation(event.target.value as Orientation | '')}
                  >
                    <option value="">{t('anyOrientation')}</option>
                    {(['landscape', 'portrait', 'square'] as const).map((value) => (
                      <option key={value} value={value}>
                        {t(`orientations.${value}`)}
                      </option>
                    ))}
                  </select>
                </div>
                {library === 'loading' ? (
                  <p className="text-muted-foreground text-sm" role="status">
                    {t('loading')}
                  </p>
                ) : library === 'error' ? (
                  <div className="flex items-center gap-2 text-sm" role="alert">
                    {t('loadFailed')}
                    <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
                      {t('retry')}
                    </Button>
                  </div>
                ) : shown.length === 0 ? (
                  <p className="text-muted-foreground py-6 text-sm">
                    {items.length === 0 ? t('emptyLibrary') : t('noMatch')}
                  </p>
                ) : (
                  <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {shown.map((asset) => {
                      const restricted = isRestricted(asset);
                      const usable = isUsable(asset);
                      const name = asset.alt?.[locale] ?? asset.alt?.[spec.defaultLocale] ?? t('untitled');
                      return (
                        <li key={asset.id}>
                          <button
                            type="button"
                            disabled={!usable}
                            title={restricted ? t('restricted') : undefined}
                            className="focus-visible:ring-ring flex w-full flex-col gap-1 rounded-md border p-1 text-left outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={() => choose(asset)}
                          >
                            {asset.publicUrl ? (
                              <img
                                src={asset.publicUrl}
                                alt=""
                                className="aspect-[4/3] w-full rounded object-cover"
                              />
                            ) : (
                              <span className="bg-muted aspect-[4/3] w-full rounded" />
                            )}
                            <span className="truncate text-xs">{name}</span>
                            <LicenseLine asset={asset} />
                            {restricted ? (
                              <Badge variant="destructive">{t('restricted')}</Badge>
                            ) : asset.status !== 'ready' ? (
                              <Badge variant="secondary">{t(`status.${asset.status}`)}</Badge>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </TabsContent>
          <TabsContent value="upload">
            <UploadForm
              siteId={siteId}
              locales={spec.locales}
              defaultLocale={spec.defaultLocale}
              onUploaded={(asset, options) => {
                if (!use(asset, options)) {
                  // Processed, but not usable as is (e.g. no alt text kept): pick it from the library.
                  setTab('library');
                  choose(asset);
                }
              }}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

type UploadState =
  | { readonly step: 'idle' }
  | { readonly step: 'uploading' | 'processing' }
  | { readonly step: 'failed'; readonly message: string };

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

/** An upload: the file, where it comes from (required), its credit, alt texts and focal point. */
function UploadForm({
  siteId,
  locales,
  defaultLocale,
  onUploaded,
}: {
  readonly siteId: string;
  readonly locales: readonly SiteLocale[];
  readonly defaultLocale: SiteLocale;
  readonly onUploaded: (asset: SiteAsset, options: { alt: LocalizedText; focalPoint: FocalPoint }) => void;
}) {
  const t = useTranslations('siteEditor.assets');
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [license, setLicense] = React.useState<CreateSiteAssetUploadRequest['license'] | ''>('');
  const [author, setAuthor] = React.useState('');
  const [sourceUrl, setSourceUrl] = React.useState('');
  const [attribution, setAttribution] = React.useState('');
  const [alt, setAlt] = React.useState<LocalizedText>({});
  const [focal, setFocal] = React.useState<FocalPoint>(CENTER);
  const [state, setState] = React.useState<UploadState>({ step: 'idle' });
  const abort = React.useRef<AbortController | null>(null);

  // The preview is an object URL owned here (img-src allows blob:).
  React.useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  React.useEffect(() => () => abort.current?.abort(), []);

  const fileProblem = !file
    ? null
    : !(SITE_ASSET_MIME_TYPES as readonly string[]).includes(file.type)
      ? t('wrongType')
      : file.size > SITE_ASSET_MAX_BYTES
        ? t('tooLarge', { max: Math.round(SITE_ASSET_MAX_BYTES / 1024 / 1024) })
        : null;
  const sourceProblem = sourceUrl && !/^https:\/\/\S+$/.test(sourceUrl) ? t('sourceUrlInvalid') : null;
  const busy = state.step === 'uploading' || state.step === 'processing';
  const ready =
    file !== null &&
    !fileProblem &&
    !sourceProblem &&
    license !== '' &&
    Boolean(alt[defaultLocale]?.trim()) &&
    !busy;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const controller = new AbortController();
    abort.current = controller;
    setState({ step: 'uploading' });
    try {
      const details = {
        ...(author.trim() ? { author: author.trim() } : {}),
        ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
        ...(attribution.trim() ? { attributionText: attribution.trim() } : {}),
      };
      const started = await uploadAsset(
        siteId,
        file,
        {
          license,
          alt: trimmed(alt) as Record<string, string>,
          ...(Object.keys(details).length > 0 ? { licenseDetails: details } : {}),
        },
        controller.signal,
      );
      setState({ step: 'processing' });
      // The variants are made by a job: the library is read again until the image is ready (or failed).
      let asset = started;
      for (let attempt = 0; attempt < POLL_TRIES && asset.status !== 'ready'; attempt++) {
        if (asset.status === 'failed') break;
        await wait(POLL_MS, controller.signal);
        asset = (await fetchAssets(siteId)).find((candidate) => candidate.id === started.id) ?? asset;
      }
      if (asset.status !== 'ready') {
        setState({ step: 'failed', message: asset.status === 'failed' ? t('processingFailed') : t('slow') });
        return;
      }
      setState({ step: 'idle' });
      onUploaded(asset, { alt, focalPoint: focal });
    } catch {
      if (!controller.signal.aborted) setState({ step: 'failed', message: t('uploadFailed') });
    }
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
      <div className="flex flex-col gap-1 text-sm">
        <label className="font-medium" htmlFor="asset-upload-file">
          {t('file')}
        </label>
        <input
          id="asset-upload-file"
          type="file"
          accept={SITE_ASSET_MIME_TYPES.join(',')}
          aria-describedby="asset-upload-file-help"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <span
          id="asset-upload-file-help"
          className={fileProblem ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
        >
          {fileProblem ?? t('fileHelp', { max: Math.round(SITE_ASSET_MAX_BYTES / 1024 / 1024) })}
        </span>
      </div>
      {preview && !fileProblem ? (
        <FocalPointPicker src={preview} alt={alt[defaultLocale] ?? ''} value={focal} onChange={setFocal} />
      ) : null}
      <div className="flex flex-col gap-1 text-sm">
        <label className="font-medium" htmlFor="asset-upload-license">
          {t('license')} *
        </label>
        <select
          id="asset-upload-license"
          required
          aria-describedby="asset-upload-license-help"
          className="border-input h-9 rounded-md border bg-transparent px-2 text-sm"
          value={license}
          onChange={(event) => setLicense(event.target.value as CreateSiteAssetUploadRequest['license'] | '')}
        >
          <option value="">{t('chooseLicense')}</option>
          {SITE_ASSET_LICENSES.map((value) => (
            <option key={value} value={value}>
              {t(`licenses.${value}`)}
            </option>
          ))}
        </select>
        <span id="asset-upload-license-help" className="text-muted-foreground text-xs">
          {t('licenseHelp')}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm" htmlFor="asset-upload-author">
          {t('author')}
          <Input
            id="asset-upload-author"
            maxLength={120}
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm" htmlFor="asset-upload-source">
          {t('sourceUrl')}
          <Input
            id="asset-upload-source"
            type="url"
            maxLength={500}
            value={sourceUrl}
            aria-invalid={sourceProblem ? true : undefined}
            onChange={(event) => setSourceUrl(event.target.value)}
          />
          {sourceProblem ? <span className="text-destructive text-xs">{sourceProblem}</span> : null}
        </label>
        <label className="flex flex-col gap-1 text-sm" htmlFor="asset-upload-credit">
          {t('attribution')}
          <Input
            id="asset-upload-credit"
            maxLength={200}
            value={attribution}
            onChange={(event) => setAttribution(event.target.value)}
          />
        </label>
      </div>
      <AltInputs
        locales={locales}
        defaultLocale={defaultLocale}
        value={alt}
        onChange={setAlt}
        idPrefix="upload-alt"
      />
      {state.step === 'failed' ? (
        <p className="text-destructive text-sm" role="alert">
          {state.message}
        </p>
      ) : null}
      <DialogFooter>
        <span className="text-muted-foreground mr-auto self-center text-xs" aria-live="polite">
          {state.step === 'uploading' ? t('uploading') : state.step === 'processing' ? t('processing') : ''}
        </span>
        <Button type="submit" disabled={!ready}>
          {t('upload')}
        </Button>
      </DialogFooter>
    </form>
  );
}
