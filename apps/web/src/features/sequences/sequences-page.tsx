'use client';

import type { Sequence, SequenceStats } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { ListOrderedIcon, PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useSequenceActions, useSequenceStats, useSequences } from './api.ts';
import { SequenceBuilder } from './builder.tsx';

// Sequences (BF-053): the workspace's follow-up sequences with their status, steps and running enrollments; create
// the starters, build or edit one (a new version), activate, archive, and read each step's and variant's results.

export function SequencesPage() {
  const t = useTranslations('sequences');
  const errorLabels = useErrorLabels();
  const list = useSequences();
  const actions = useSequenceActions();
  const canManage = usePermission('templates:manage');
  const [editing, setEditing] = React.useState<Sequence | null>(null);
  const [building, setBuilding] = React.useState(false);
  const [statsOf, setStatsOf] = React.useState<string | null>(null);
  const run = async (call: () => Promise<unknown>, done: string) => {
    const toast = await getToast();
    try {
      await call();
      toast.success(done);
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  return (
    <div className="space-y-4">
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setBuilding(true);
            }}
          >
            <PlusIcon aria-hidden />
            {t('new')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void run(() => actions.starters.mutateAsync('fr'), t('startersCreated'))}
          >
            {t('startersFr')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void run(() => actions.starters.mutateAsync('en'), t('startersCreated'))}
          >
            {t('startersEn')}
          </Button>
        </div>
      ) : null}
      {list.isError ? (
        <ErrorState
          problem={toProblemLike(list.error, t('loadError'))}
          labels={errorLabels}
          onRetry={() => void list.refetch()}
        />
      ) : !list.data ? (
        <Skeleton className="h-48 w-full" />
      ) : list.data.length === 0 ? (
        <EmptyState
          icon={<ListOrderedIcon aria-hidden />}
          title={t('emptyTitle')}
          description={t('emptyBody')}
        />
      ) : (
        <ul className="space-y-3">
          {list.data.map((sequence) => (
            <li key={sequence.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{sequence.name}</span>
                <Badge variant={sequence.status === 'active' ? 'secondary' : 'outline'}>
                  {t(`status.${sequence.status}`)}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {t('summary', {
                    steps: sequence.steps.length,
                    version: sequence.version,
                    running: sequence.activeEnrollments,
                  })}
                </span>
                <div className="ml-auto flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setStatsOf(statsOf === sequence.id ? null : sequence.id)}
                  >
                    {t('stats')}
                  </Button>
                  {canManage && sequence.status !== 'archived' ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(sequence);
                          setBuilding(true);
                        }}
                      >
                        {t('edit')}
                      </Button>
                      {sequence.status === 'draft' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void run(() => actions.activate.mutateAsync(sequence.id), t('activated'))
                          }
                        >
                          {t('activate')}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void run(() => actions.archive.mutateAsync(sequence.id), t('archived'))
                        }
                      >
                        {t('archive')}
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {sequence.steps
                  .map((step) => `${t(`kinds.${step.kind}`)} +${step.wait.businessDays}`)
                  .join(' → ')}
              </p>
              {statsOf === sequence.id ? <StatsTable sequenceId={sequence.id} /> : null}
            </li>
          ))}
        </ul>
      )}
      <SequenceBuilder open={building} sequence={editing} onClose={() => setBuilding(false)} />
    </div>
  );
}

function StatsTable({ sequenceId }: { readonly sequenceId: string }) {
  const t = useTranslations('sequences.statsTable');
  const stats = useSequenceStats(sequenceId);
  if (!stats.data) return <Skeleton className="mt-3 h-24 w-full" />;
  if (stats.data.steps.length === 0) return <p className="mt-3 text-xs text-muted-foreground">{t('none')}</p>;
  const cell = (rate: SequenceStats['steps'][number]['variants'][number]['replies']) =>
    rate.rate === null ? (
      '—'
    ) : (
      <span
        title={t('interval', {
          low: Math.round((rate.low ?? 0) * 100),
          high: Math.round((rate.high ?? 0) * 100),
        })}
      >
        <span
          className="mr-1 inline-block h-2 rounded bg-primary/70 align-middle"
          style={{ width: `${Math.round(rate.rate * 40)}px` }}
          aria-hidden
        />
        {Math.round(rate.rate * 100)}%{rate.insufficient ? ' *' : ''}
      </span>
    );
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="sr-only">{t('caption')}</caption>
        <thead className="text-left text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 pr-3 font-normal">
              {t('step')}
            </th>
            <th scope="col" className="py-1 pr-3 font-normal">
              {t('variant')}
            </th>
            <th scope="col" className="py-1 pr-3 font-normal">
              {t('sent')}
            </th>
            <th scope="col" className="py-1 pr-3 font-normal">
              {t('replies')}
            </th>
            <th scope="col" className="py-1 pr-3 font-normal">
              {t('positive')}
            </th>
            <th scope="col" className="py-1 pr-3 font-normal">
              {t('views')}
            </th>
            <th scope="col" className="py-1 pr-3 font-normal">
              {t('bounces')}
            </th>
            <th scope="col" className="py-1 pr-3 font-normal">
              {t('unsubscribes')}
            </th>
          </tr>
        </thead>
        <tbody>
          {stats.data.steps.flatMap((step) =>
            step.variants.map((variant) => (
              <tr key={`${step.stepId}-${variant.variantId}`} className="border-t">
                <td className="py-1 pr-3">{step.stepId}</td>
                <td className="py-1 pr-3">{variant.variantId}</td>
                <td className="py-1 pr-3">{variant.sent}</td>
                <td className="py-1 pr-3">{cell(variant.replies)}</td>
                <td className="py-1 pr-3">{cell(variant.positive)}</td>
                <td className="py-1 pr-3">{cell(variant.previewViews)}</td>
                <td className="py-1 pr-3">{cell(variant.bounces)}</td>
                <td className="py-1 pr-3">{cell(variant.unsubscribes)}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-muted-foreground">{t('insufficient')}</p>
    </div>
  );
}
