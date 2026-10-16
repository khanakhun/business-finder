'use client';

import type { SiteAsset, SiteAssetCandidate, SiteAssetSources } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Input } from '@bf/ui/components/input';
import { Textarea } from '@bf/ui/components/textarea';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { fetchAssets, generateImages, importStock, searchStock } from '../api.ts';

// "Find more images" (BF-038): stock photos (Unsplash, Pexels — whichever the workspace configured) and
// illustrative AI images. A stock photo picked is imported into the library (credited; Unsplash hotlinked), then
// used; AI images arrive in the library after generation and the policy check.

const POLL_MS = 2_000;
const POLL_TRIES = 45;

export function FindMore({
  siteId,
  sources,
  onImported,
  onGenerated,
}: {
  readonly siteId: string;
  readonly sources: SiteAssetSources;
  /** A library image ready to use (a stock photo imported). */
  readonly onImported: (asset: SiteAsset) => void;
  /** AI images are in the library (the picker shows it). */
  readonly onGenerated: () => void;
}) {
  const t = useTranslations('siteEditor.assets.more');
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<readonly SiteAssetCandidate[] | 'loading' | 'error' | null>(
    null,
  );
  const [importing, setImporting] = React.useState<string | null>(null);
  const [prompt, setPrompt] = React.useState('');
  const [aspect, setAspect] = React.useState<'16:9' | '4:3' | '1:1' | '3:4'>('16:9');
  const [generation, setGeneration] = React.useState<'idle' | 'running' | 'done' | 'failed' | 'refused'>(
    'idle',
  );
  const [message, setMessage] = React.useState<string | null>(null);
  const abort = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => abort.current?.abort(), []);

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    setResults('loading');
    try {
      setResults(await searchStock(siteId, query.trim()));
    } catch {
      setResults('error');
    }
  };

  const take = async (candidate: SiteAssetCandidate) => {
    setImporting(candidate.id);
    try {
      let asset = await importStock(siteId, candidate.id);
      // A copied photo (Pexels) is processed first; a hotlinked one (Unsplash) is ready at once.
      for (let attempt = 0; attempt < POLL_TRIES && asset.status === 'processing'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        asset = (await fetchAssets(siteId)).find((candidateAsset) => candidateAsset.id === asset.id) ?? asset;
      }
      if (asset.status === 'ready') onImported(asset);
      else setMessage(t('importSlow'));
    } catch {
      setMessage(t('importFailed'));
    } finally {
      setImporting(null);
    }
  };

  const generate = async (event: React.FormEvent) => {
    event.preventDefault();
    const controller = new AbortController();
    abort.current = controller;
    setGeneration('running');
    setMessage(null);
    try {
      const before = new Set((await fetchAssets(siteId)).map((asset) => asset.id));
      const { count } = await generateImages(siteId, { prompt: prompt.trim(), aspect, count: 2 });
      for (let attempt = 0; attempt < POLL_TRIES && !controller.signal.aborted; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const fresh = (await fetchAssets(siteId)).filter(
          (asset) => !before.has(asset.id) && asset.source === 'ai' && asset.status !== 'processing',
        );
        if (fresh.length >= count) break;
      }
      setGeneration('done');
      onGenerated();
    } catch (error) {
      const refused =
        error instanceof Error && /422|policy|VALIDATION/i.test(`${error.name} ${error.message}`);
      setGeneration(refused ? 'refused' : 'failed');
    }
  };

  const stock = sources.stock.length > 0;
  return (
    <div className="flex flex-col gap-6">
      {stock ? (
        <section className="flex flex-col gap-3" aria-labelledby="find-more-stock">
          <h3 id="find-more-stock" className="text-sm font-semibold">
            {t('stockTitle', {
              providers: sources.stock.map((name) => name[0]?.toUpperCase() + name.slice(1)).join(', '),
            })}
          </h3>
          <form className="flex gap-2" onSubmit={(event) => void search(event)}>
            <Input
              type="search"
              aria-label={t('stockQuery')}
              placeholder={t('stockPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button type="submit" variant="outline" disabled={!query.trim() || results === 'loading'}>
              {t('search')}
            </Button>
          </form>
          {results === 'loading' ? (
            <p className="text-muted-foreground text-sm" role="status">
              {t('searching')}
            </p>
          ) : results === 'error' ? (
            <p className="text-destructive text-sm" role="alert">
              {t('searchFailed')}
            </p>
          ) : results && results.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noResults')}</p>
          ) : results ? (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {results.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    disabled={importing !== null}
                    className="focus-visible:ring-ring flex w-full flex-col gap-1 rounded-md border p-1 text-left outline-none focus-visible:ring-2 disabled:opacity-60"
                    onClick={() => void take(candidate)}
                  >
                    {candidate.previewUrl ? (
                      <img
                        src={candidate.previewUrl}
                        alt=""
                        className="aspect-[4/3] w-full rounded object-cover"
                      />
                    ) : null}
                    <span className="text-muted-foreground truncate text-xs">{candidate.attribution}</span>
                    {importing === candidate.id ? (
                      <span className="text-xs" role="status">
                        {t('importing')}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {sources.ai.enabled ? (
        <section className="flex flex-col gap-3" aria-labelledby="find-more-ai">
          <h3 id="find-more-ai" className="text-sm font-semibold">
            {t('aiTitle')}
          </h3>
          <p className="text-muted-foreground text-xs">{t('aiHelp', { count: sources.ai.remainingToday })}</p>
          <form className="flex flex-col gap-2" onSubmit={(event) => void generate(event)}>
            <Textarea
              aria-label={t('aiPrompt')}
              placeholder={t('aiPlaceholder')}
              maxLength={400}
              rows={2}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <select
                aria-label={t('aspect')}
                className="border-input h-9 rounded-md border bg-transparent px-2 text-sm"
                value={aspect}
                onChange={(event) => setAspect(event.target.value as typeof aspect)}
              >
                {(['16:9', '4:3', '1:1', '3:4'] as const).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <Button
                type="submit"
                disabled={
                  prompt.trim().length < 3 || generation === 'running' || sources.ai.remainingToday < 2
                }
              >
                {generation === 'running' ? t('generating') : t('generate')}
              </Button>
            </div>
          </form>
          <p className="text-sm" aria-live="polite">
            {generation === 'done'
              ? t('generated')
              : generation === 'refused'
                ? t('refused')
                : generation === 'failed'
                  ? t('generateFailed')
                  : ''}
          </p>
        </section>
      ) : null}
      {message ? (
        <p className="text-destructive text-sm" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
