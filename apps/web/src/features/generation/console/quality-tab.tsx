'use client';

import type { QualityIssue, QualityReport } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Dialog, DialogContent, DialogTitle } from '@bf/ui/components/dialog';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleMinusIcon,
  CircleXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { useQuality } from '../api.ts';
import { fetchScreenshot } from './screenshots.ts';

// The Quality tab (BF-046 on BF-045): the decision and score, each gate's result, the issues grouped by page and
// section (a click opens the editor on that page), the visual critic's rubric as bars with the numbers, the graded
// screenshots (a click enlarges) and the auto-fixes applied.

const STATUS_ICON = {
  pass: CircleCheckIcon,
  fail: CircleXIcon,
  skipped: CircleMinusIcon,
  error: CircleAlertIcon,
} as const;

interface IssueGroup {
  readonly key: string;
  readonly pageId: string | null;
  readonly blockId: string | null;
  readonly issues: QualityIssue[];
}

/** Issues by page, then section (site-wide ones first). */
export function groupIssues(issues: readonly QualityIssue[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const issue of issues) {
    const pageId = issue.target?.pageId ?? null;
    const blockId = pageId ? (issue.target?.blockId ?? null) : null;
    const key = `${pageId ?? ''}/${blockId ?? ''}`;
    const group = groups.get(key) ?? { key, pageId, blockId, issues: [] };
    group.issues.push(issue);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.pageId === null ? -1 : b.pageId === null ? 1 : 0));
}

export function QualityTab({ jobId, siteId }: { readonly jobId: string; readonly siteId: string | null }) {
  const t = useTranslations('generation.console.quality');
  const quality = useQuality(jobId);
  if (quality.isLoading) return <Skeleton className="h-40 w-full" />;
  if (quality.isError) return <p className="text-sm text-destructive">{t('error')}</p>;
  const report = quality.data?.report ?? null;
  if (!report) return <p className="text-sm text-muted-foreground">{t('none')}</p>;
  return <Report jobId={jobId} siteId={siteId} report={report} />;
}

function Report({
  jobId,
  siteId,
  report,
}: {
  readonly jobId: string;
  readonly siteId: string | null;
  readonly report: QualityReport;
}) {
  const t = useTranslations('generation.console.quality');
  const gates = useTranslations('generation.console.quality.gates');
  const format = useFormatter();
  const rubric = report.gates.find((gate) => gate.rubric)?.rubric;
  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-center gap-3">
        <span className="text-2xl font-semibold tabular-nums" data-testid="quality-score">
          {report.score}
        </span>
        <span className="text-sm text-muted-foreground">/ 100</span>
        <Badge variant={report.decision === 'pass' ? 'default' : 'secondary'}>
          {t(`decision.${report.decision}`)}
        </Badge>
        {report.infraError ? <Badge variant="destructive">{t('infraError')}</Badge> : null}
      </section>

      <section aria-labelledby="gates-title" className="space-y-2">
        <h3 id="gates-title" className="text-sm font-medium">
          {t('gatesTitle')}
        </h3>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1 font-normal">{t('gate')}</th>
              <th className="py-1 font-normal">{t('result')}</th>
              <th className="py-1 font-normal">{t('score')}</th>
              <th className="py-1 font-normal">{t('issueCount')}</th>
              <th className="py-1 font-normal">{t('time')}</th>
            </tr>
          </thead>
          <tbody>
            {report.gates.map((gate) => {
              const Icon = STATUS_ICON[gate.status];
              return (
                <tr key={gate.id} className="border-t" data-gate={gate.id}>
                  <td className="py-1">{gates(gate.id)}</td>
                  <td className="py-1">
                    <span
                      className={`inline-flex items-center gap-1 ${gate.status === 'pass' ? 'text-emerald-800 dark:text-emerald-200' : gate.status === 'skipped' ? 'text-muted-foreground' : 'text-destructive'}`}
                    >
                      <Icon aria-hidden className="size-4" />
                      {t(`status.${gate.status}`)}
                    </span>
                  </td>
                  <td className="py-1 tabular-nums">
                    {gate.score !== undefined ? Math.round(gate.score) : '—'}
                  </td>
                  <td className="py-1 tabular-nums">{gate.issues.length}</td>
                  <td className="py-1 tabular-nums">
                    {format.number(gate.durationMs / 1000, { maximumFractionDigits: 1 })} s
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {report.issues.length > 0 ? (
        <section aria-labelledby="issues-title" className="space-y-3">
          <h3 id="issues-title" className="text-sm font-medium">
            {t('issuesTitle', { count: report.issues.length })}
          </h3>
          {groupIssues(report.issues).map((group) => (
            <div key={group.key} className="space-y-1">
              <h4 className="text-xs font-semibold">
                {group.pageId === null
                  ? t('siteWide')
                  : group.blockId
                    ? t('pageBlock', { page: group.pageId, block: group.blockId })
                    : t('page', { page: group.pageId })}
                {siteId && group.pageId ? (
                  <Link
                    href={`/sites/${siteId}/edit?page=${encodeURIComponent(group.pageId)}`}
                    className="ml-2 font-normal text-lagoon hover:underline"
                  >
                    {t('openInEditor')}
                  </Link>
                ) : null}
              </h4>
              <ul className="space-y-1">
                {group.issues.map((issue, index) => (
                  <li key={`${issue.code}-${index}`} className="flex items-start gap-2 text-sm">
                    {issue.severity === 'error' ? (
                      <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
                    ) : (
                      <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-700" />
                    )}
                    <span>
                      <span className="sr-only">{t(`severity.${issue.severity}`)}: </span>
                      {issue.message}
                      <span className="ml-1 font-mono text-xs text-muted-foreground">
                        {gates(issue.gate)} · {issue.code}
                      </span>
                      {issue.suggestedFix ? (
                        <span className="block text-xs text-muted-foreground">{issue.suggestedFix}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}

      {rubric ? (
        <section aria-labelledby="rubric-title" className="space-y-2">
          <h3 id="rubric-title" className="text-sm font-medium">
            {t('rubricTitle')}
          </h3>
          <table className="w-full max-w-lg text-sm">
            <thead className="sr-only">
              <tr>
                <th>{t('criterion')}</th>
                <th>{t('rubricScore')}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(rubric).map(([criterion, score]) => (
                <tr key={criterion}>
                  <td className="w-40 py-1 pr-2">
                    {t.has(`criteria.${criterion}` as never)
                      ? t(`criteria.${criterion}` as never)
                      : criterion}
                  </td>
                  <td className="py-1">
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="h-2 flex-1 rounded-full bg-muted">
                        <span
                          className="block h-2 rounded-full bg-lagoon"
                          style={{ width: `${(score / 5) * 100}%` }}
                        />
                      </span>
                      <span className="w-10 tabular-nums">{score}/5</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {report.screenshots.length > 0 ? (
        <section aria-labelledby="shots-title" className="space-y-2">
          <h3 id="shots-title" className="text-sm font-medium">
            {t('screenshotsTitle')}
          </h3>
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {report.screenshots.map((shot, index) => (
              <li key={shot.ref}>
                <Screenshot
                  jobId={jobId}
                  index={index}
                  label={t('screenshot', { page: shot.page, viewport: shot.viewport })}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {report.autoFixes.length > 0 ? (
        <section aria-labelledby="fixes-title" className="space-y-2">
          <h3 id="fixes-title" className="text-sm font-medium">
            {t('autoFixesTitle', { count: report.autoFixes.length })}
          </h3>
          <ul className="space-y-1 text-sm">
            {report.autoFixes.map((fix, index) => (
              <li key={`${fix.path}-${index}`}>
                <span className="font-mono text-xs">{fix.rule}</span>{' '}
                <span className="text-muted-foreground">{fix.path}</span>
                {fix.before !== undefined && fix.after !== undefined ? (
                  <span className="block text-xs">
                    <del>{fix.before}</del> → <ins>{fix.after}</ins>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** One screenshot, loaded with the session cookie into an object URL; a click opens it large. */
function Screenshot({
  jobId,
  index,
  label,
}: {
  readonly jobId: string;
  readonly index: number;
  readonly label: string;
}) {
  const t = useTranslations('generation.console.quality');
  const image = useQuery({
    queryKey: ['generation', 'screenshot', jobId, index],
    queryFn: () => fetchScreenshot(jobId, index),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [url, setUrl] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!image.data) return;
    const objectUrl = URL.createObjectURL(image.data);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image.data]);
  if (image.isError) return <p className="text-xs text-muted-foreground">{t('screenshotMissing')}</p>;
  if (!url) return <Skeleton className="aspect-[4/3] w-full" />;
  return (
    <>
      <button
        type="button"
        className="block w-full"
        onClick={() => setOpen(true)}
        aria-label={t('enlarge', { label })}
      >
        <img src={url} alt={label} className="aspect-[4/3] w-full rounded border object-cover object-top" />
      </button>
      <span className="text-xs text-muted-foreground">{label}</span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-auto">
          <DialogTitle>{label}</DialogTitle>
          <img src={url} alt={label} className="w-full" />
        </DialogContent>
      </Dialog>
    </>
  );
}
