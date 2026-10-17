'use client';

import type { GenerationBrief, GenerationJobWorkspace } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useFormatter, useTranslations } from 'next-intl';
import { useJobWorkspace } from '../api.ts';

// The Brief tab (BF-046): what the engine was given — the brief, the facts it could state (with their provenance) and
// the images it could use (with their licences), as written into the job's latest workspace bundle. Values are data
// from the business and its sources: shown as text, never as markup.

const MAX_VALUE = 160;

/** A fact's value as one line of text. */
export function factText(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

const str = (value: unknown) => (typeof value === 'string' ? value : null);

export function BriefTab({ jobId }: { readonly jobId: string }) {
  const t = useTranslations('generation.console.brief');
  const workspace = useJobWorkspace(jobId, true);
  if (workspace.isLoading) return <Skeleton className="h-40 w-full" />;
  if (workspace.isError || !workspace.data)
    return <p className="text-sm text-muted-foreground">{t('none')}</p>;
  return <Workspace data={workspace.data} />;
}

function Workspace({ data }: { readonly data: GenerationJobWorkspace }) {
  const t = useTranslations('generation.console.brief');
  const format = useFormatter();
  const brief = data.brief as Partial<GenerationBrief>;
  return (
    <div className="space-y-6 text-sm">
      <p className="text-xs text-muted-foreground">
        {t('bundle', {
          attempt: data.bundle.attemptNo ?? '—',
          hash: data.bundle.sha256.slice(0, 12),
          when: format.dateTime(new Date(data.bundle.createdAt), { dateStyle: 'medium', timeStyle: 'short' }),
        })}
      </p>
      <section aria-labelledby="brief-summary" className="space-y-2">
        <h3 id="brief-summary" className="font-medium">
          {t('summary')}
        </h3>
        <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">{t('name')}</dt>
          <dd>{brief.identity?.name ?? '—'}</dd>
          <dt className="text-muted-foreground">{t('category')}</dt>
          <dd>{brief.identity?.categoryLabel?.en ?? brief.identity?.categoryPath ?? '—'}</dd>
          <dt className="text-muted-foreground">{t('place')}</dt>
          <dd>{[brief.identity?.locality, brief.identity?.area].filter(Boolean).join(', ') || '—'}</dd>
          <dt className="text-muted-foreground">{t('offer')}</dt>
          <dd>{brief.offer?.id ?? '—'}</dd>
          <dt className="text-muted-foreground">{t('pages')}</dt>
          <dd className="flex flex-wrap gap-1">
            {(brief.pagePlan?.pages ?? []).map((page) => (
              <Badge key={page.kind} variant="secondary">
                {page.kind}
              </Badge>
            ))}
          </dd>
          <dt className="text-muted-foreground">{t('design')}</dt>
          <dd className="flex items-center gap-2">
            {brief.design?.style ?? '—'}
            {brief.design
              ? [brief.design.palette.primary, brief.design.palette.accent].map((color) => (
                  <span
                    key={color}
                    title={color}
                    className="inline-block size-4 rounded-full border"
                    style={{ backgroundColor: color }}
                  />
                ))
              : null}
          </dd>
          <dt className="text-muted-foreground">{t('locales')}</dt>
          <dd>{(brief.locales?.available ?? []).join(', ').toUpperCase() || '—'}</dd>
          <dt className="text-muted-foreground">{t('tone')}</dt>
          <dd>{brief.constraints?.tone ?? '—'}</dd>
          {brief.extraInstructions ? (
            <>
              <dt className="text-muted-foreground">{t('instructions')}</dt>
              <dd className="whitespace-pre-wrap">{brief.extraInstructions}</dd>
            </>
          ) : null}
        </dl>
        {(brief.warnings ?? []).length > 0 ? (
          <ul className="list-disc pl-5 text-amber-800 dark:text-amber-200">
            {(brief.warnings ?? []).map((warning) => (
              <li key={warning.code}>{warning.message}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="brief-facts" className="space-y-2">
        <h3 id="brief-facts" className="font-medium">
          {t('facts', { count: data.facts.length })}
        </h3>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">{t('kind')}</th>
                <th className="px-3 py-2 font-normal">{t('value')}</th>
                <th className="px-3 py-2 font-normal">{t('shown')}</th>
                <th className="px-3 py-2 font-normal">{t('source')}</th>
              </tr>
            </thead>
            <tbody>
              {data.facts.map((fact) => (
                <tr key={fact.id} className="border-t align-top">
                  <td className="px-3 py-1.5 font-mono text-xs">{fact.kind}</td>
                  <td className="px-3 py-1.5 break-words">{factText(fact.value)}</td>
                  <td className="px-3 py-1.5">{fact.display === false ? t('internal') : t('display')}</td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">
                    {[
                      str(fact.sourceRef),
                      fact.observedAt
                        ? format.dateTime(new Date(fact.observedAt), { dateStyle: 'medium' })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="brief-assets" className="space-y-2">
        <h3 id="brief-assets" className="font-medium">
          {t('assets', { count: data.assets.length })}
        </h3>
        {data.assets.length === 0 ? (
          <p className="text-muted-foreground">{t('noAssets')}</p>
        ) : (
          <ul className="space-y-1">
            {data.assets.map((asset) => (
              <li key={asset.id} className="flex flex-wrap gap-x-3">
                <span className="font-mono text-xs">{asset.id}</span>
                <span>{str(asset.license) ?? str(asset.licence) ?? '—'}</span>
                <span className="text-muted-foreground">{str(asset.credit) ?? str(asset.source) ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
