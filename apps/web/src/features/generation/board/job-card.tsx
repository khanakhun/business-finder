'use client';

import { ENGINE_IDS, type GenerationEngineListing, type GenerationJob } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@bf/ui/components/dropdown-menu';
import { Progress } from '@bf/ui/components/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@bf/ui/components/tooltip';
import { cn } from '@bf/ui/lib/utils';
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  PencilIcon,
  RotateCcwIcon,
  SkipForwardIcon,
  XIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { getToast } from '@/lib/toast.tsx';
import type { useJobActions } from '../api.ts';
import { EngineSelect } from '../create/engine-select.tsx';
import { unavailableReason } from '../engines.ts';
import { AcceptJobDialog, CancelJobDialog } from './job-dialogs.tsx';
import { stepsOf, TERMINAL } from './status-stepper.ts';

// One job on the board (BF-046): where it is (stepper), which engine (and why, when it changed), what it cost against
// its budget, and what can be done now — reprioritize or change engine while queued, cancel while running, retry,
// accept anyway or open the result once settled. Everything shown comes from the API; nothing is simulated.

const RUNNING: ReadonlySet<GenerationJob['status']> = new Set([
  'preparing',
  'running',
  'validating',
  'repairing',
]);

export function JobCard({
  job,
  listing,
  actions,
  canStartNext,
  onStartNext,
  now,
}: {
  readonly job: GenerationJob;
  readonly listing: GenerationEngineListing | undefined;
  readonly actions: ReturnType<typeof useJobActions>;
  readonly canStartNext: boolean;
  readonly onStartNext: () => void;
  readonly now: number;
}) {
  const t = useTranslations('generation.board');
  const status = useTranslations('generation.status');
  const engines = useTranslations('generation.engines.name');
  const format = useFormatter();
  const [cancelling, setCancelling] = React.useState(false);
  const [accepting, setAccepting] = React.useState(false);
  const steps = stepsOf(job.status, job.attemptCount);
  const settled = TERMINAL.has(job.status);
  const started = job.startedAt ? Date.parse(job.startedAt) : null;
  const ended = job.finishedAt ? Date.parse(job.finishedAt) : now;
  const elapsedSec = started ? Math.max(0, Math.round((ended - started) / 1000)) : null;
  const spent = job.budgetUsd > 0 ? Math.min(100, (job.costUsd / job.budgetUsd) * 100) : 0;
  const failedOver = job.engineRequested !== 'auto' && job.engineRequested !== job.engineCurrent;
  const copy = async () => {
    if (!job.publishedUrl) return;
    const toast = await getToast();
    try {
      await navigator.clipboard.writeText(job.publishedUrl);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };
  const fail = async () => (await getToast()).error(t('actionFailed'));
  return (
    <article
      aria-labelledby={`job-${job.id}-name`}
      data-job-id={job.id}
      data-status={job.status}
      className="space-y-2"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h2 id={`job-${job.id}-name`} className="font-medium">
          {job.businessName}
        </h2>
        <Badge
          variant={
            job.status === 'failed' ? 'destructive' : job.status === 'succeeded' ? 'default' : 'secondary'
          }
          data-testid="job-status"
        >
          {status(job.status)}
        </Badge>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" tabIndex={0}>
              {failedOver
                ? `${engines(job.engineRequested)} → ${engines(job.engineCurrent)}`
                : engines(job.engineCurrent)}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{job.engineSelectionReason}</TooltipContent>
        </Tooltip>
        {job.qualityScore !== null ? (
          <Badge variant="outline" className="tabular-nums">
            {t('quality', { score: Math.round(job.qualityScore) })}
          </Badge>
        ) : null}
      </header>
      <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label={t('steps')}>
        {steps.map((step, index) => (
          <li key={step.id} className="flex items-center gap-1">
            {index > 0 ? <span aria-hidden className="h-px w-3 bg-border" /> : null}
            <span
              aria-current={step.state === 'current' ? 'step' : undefined}
              className={cn(
                'rounded-full px-2 py-0.5',
                step.state === 'done' && 'bg-muted text-foreground',
                step.state === 'current' && 'bg-lagoon-wash font-medium text-foreground ring-1 ring-lagoon',
                step.state === 'todo' && 'text-muted-foreground',
                step.id === 'failed' && 'bg-destructive/10 text-destructive',
              )}
            >
              {step.id === 'result' ? t('result') : status(step.id)}
            </span>
          </li>
        ))}
      </ol>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {elapsedSec !== null ? (
          <div className="flex gap-1">
            <dt>{t('elapsed')}</dt>
            <dd className="tabular-nums">{formatDuration(elapsedSec)}</dd>
          </div>
        ) : null}
        <div className="flex gap-1">
          <dt>{t('attempts')}</dt>
          <dd className="tabular-nums">{job.attemptCount}</dd>
        </div>
        <div className="flex min-w-40 items-center gap-1">
          <dt>{t('cost')}</dt>
          <dd className="flex items-center gap-1 tabular-nums">
            {format.number(job.costUsd, { style: 'currency', currency: 'USD' })} /{' '}
            {format.number(job.budgetUsd, { style: 'currency', currency: 'USD' })}
            <Progress value={spent} className="h-1.5 w-16" aria-label={t('budgetUsed')} />
          </dd>
        </div>
      </dl>
      {job.errorMessage && (job.status === 'failed' || job.status === 'needs_review') ? (
        <p className="text-xs text-destructive">{job.errorMessage}</p>
      ) : null}
      {job.publishedUrl ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <a
            href={job.publishedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-lagoon hover:underline"
            data-testid="preview-url"
          >
            <ExternalLinkIcon aria-hidden className="size-4" />
            {t('openPreview')}
          </a>
          <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => void copy()}>
            <CopyIcon aria-hidden />
            {t('copy')}
          </Button>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {job.status === 'queued' ? (
          <>
            {canStartNext ? (
              <Button type="button" size="sm" variant="outline" onClick={onStartNext}>
                <SkipForwardIcon aria-hidden />
                {t('startNext')}
              </Button>
            ) : null}
            <EngineSelect
              value={job.engineRequested}
              listing={listing}
              label={t('changeEngine', { name: job.businessName })}
              onChange={(engine) =>
                actions.changeEngine.mutate({ jobId: job.id, engine }, { onError: () => void fail() })
              }
            />
          </>
        ) : null}
        {job.status === 'queued' || RUNNING.has(job.status) ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setCancelling(true)}>
            <XIcon aria-hidden />
            {t('cancel')}
          </Button>
        ) : null}
        {job.status === 'failed' || job.status === 'cancelled' || job.status === 'needs_review' ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="sm" variant="outline">
                <RotateCcwIcon aria-hidden />
                {t('retry')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>{t('retryWith')}</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => actions.retry.mutate({ jobId: job.id }, { onError: () => void fail() })}
              >
                {t('sameEngine', { engine: engines(job.engineCurrent) })}
              </DropdownMenuItem>
              {ENGINE_IDS.filter(
                (engine) => engine !== job.engineCurrent && unavailableReason(engine, listing) === null,
              ).map((engine) => (
                <DropdownMenuItem
                  key={engine}
                  onSelect={() =>
                    actions.retry.mutate({ jobId: job.id, engine }, { onError: () => void fail() })
                  }
                >
                  {engines(engine)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {job.status === 'needs_review' ? (
          <Button type="button" size="sm" onClick={() => setAccepting(true)}>
            <CheckIcon aria-hidden />
            {t('accept')}
          </Button>
        ) : null}
        {settled && job.siteId ? (
          <Button asChild size="sm" variant="ghost">
            <Link href={`/sites/${job.siteId}/edit`}>
              <PencilIcon aria-hidden />
              {t('openEditor')}
            </Link>
          </Button>
        ) : null}
      </div>
      <CancelJobDialog
        name={job.businessName}
        open={cancelling}
        onOpenChange={setCancelling}
        pending={actions.cancel.isPending}
        onConfirm={() =>
          actions.cancel.mutate(job.id, {
            onSuccess: () => setCancelling(false),
            onError: () => void fail(),
          })
        }
      />
      {job.status === 'needs_review' ? (
        <AcceptJobDialog
          jobId={job.id}
          name={job.businessName}
          open={accepting}
          onOpenChange={setAccepting}
          pending={actions.accept.isPending}
          onConfirm={(reason) =>
            actions.accept.mutate(
              { jobId: job.id, reason },
              { onSuccess: () => setAccepting(false), onError: () => void fail() },
            )
          }
        />
      ) : null}
    </article>
  );
}

/** 75 → "1:15", 3 725 → "1:02:05". */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
