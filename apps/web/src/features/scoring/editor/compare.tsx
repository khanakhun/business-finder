'use client';

import type { ScoreTier, ScoringPreviewSample, ScoringProfileVersionList } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { explainAll, useProfileVersion } from '../api.ts';
import { type Scored, spearman, TIERS, type TierMatrix, tierMatrix } from './preview-stats.ts';

// Version comparison (BF-032): two saved versions scored over the preview sample by the server's engine — how many
// businesses move from each tier to each tier (X included), and how well the rankings agree.

type Result = {
  readonly from: number;
  readonly to: number;
  readonly matrix: TierMatrix;
  readonly rho: number | null;
  readonly count: number;
};

export function CompareVersions({
  profileId,
  versions,
  sample,
}: {
  readonly profileId: string;
  readonly versions: ScoringProfileVersionList['items'];
  readonly sample: ScoringPreviewSample | undefined;
}) {
  const t = useTranslations('scoringEditor.compare');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  // Versions come newest first: compare the newest other version with the active one.
  const active = versions.find((v) => v.active)?.version ?? versions[0]?.version ?? null;
  const other = versions.find((v) => v.version !== active)?.version ?? null;
  const [left, setLeft] = React.useState<number | null>(other);
  const [right, setRight] = React.useState<number | null>(active);
  // A version saved later fills an empty picker.
  React.useEffect(() => {
    setLeft((current) => current ?? other);
    setRight((current) => current ?? active);
  }, [other, active]);
  const a = useProfileVersion(profileId, left);
  const b = useProfileVersion(profileId, right);
  const [result, setResult] = React.useState<Result | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const running = React.useRef<AbortController | null>(null);
  const ids = (sample?.items ?? []).map((item) => item.businessId);
  // Leaving the page cancels a comparison under way.
  React.useEffect(() => () => running.current?.abort(), []);

  const run = async () => {
    if (!a.data || !b.data || left === null || right === null) return;
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setPending(true);
    setError(null);
    try {
      // One after the other: a failure stops before the second half is spent.
      const first = await explainAll(a.data.config, ids, controller.signal);
      const second = await explainAll(b.data.config, ids, controller.signal);
      if (controller.signal.aborted) return;
      const as = (items: typeof first): Scored[] =>
        items.map((item) => ({
          businessId: item.businessId,
          score: item.score,
          tier: item.tier as ScoreTier,
        }));
      setResult({
        from: left,
        to: right,
        matrix: tierMatrix(as(first), as(second)),
        rho: spearman(as(first), as(second)),
        count: first.length,
      });
    } catch (caught) {
      if (!controller.signal.aborted) setError(errorMessage(caught));
    } finally {
      if (running.current === controller) {
        running.current = null;
        setPending(false);
      }
    }
  };

  const picker = (id: string, label: string, value: number | null, onChange: (v: number) => void) => (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value === null ? '' : String(value)}
        onValueChange={(next) => {
          running.current?.abort();
          running.current = null;
          setPending(false);
          setResult(null);
          onChange(Number(next));
        }}
      >
        <SelectTrigger id={id} className="w-44">
          <SelectValue placeholder={t('pick')} />
        </SelectTrigger>
        <SelectContent>
          {versions.map((v) => (
            <SelectItem key={v.version} value={String(v.version)}>
              {v.active ? t('activeVersion', { version: v.version }) : t('version', { version: v.version })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  if (versions.length < 2) return <p className="text-sm text-muted-foreground">{t('needTwo')}</p>;
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      <div className="flex flex-wrap items-end gap-3">
        {picker('compare-from', t('from'), left, setLeft)}
        {picker('compare-to', t('to'), right, setRight)}
        <Button
          type="button"
          variant="outline"
          disabled={
            pending ||
            left === null ||
            right === null ||
            left === right ||
            !a.data ||
            !b.data ||
            ids.length === 0
          }
          onClick={() => void run()}
        >
          {t('run')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="grid gap-3" aria-live="polite">
          <table className="w-fit text-sm" data-testid="tier-matrix">
            <caption className="mb-1 text-left text-muted-foreground">
              {t('matrixCaption', { from: result.from, to: result.to, count: result.count })}
            </caption>
            <thead>
              <tr>
                <td aria-hidden />
                {TIERS.map((tier) => (
                  <th key={tier} scope="col" className="px-3 font-medium">
                    {t('toTier', { tier })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TIERS.map((from) => (
                <tr key={from} className="border-t">
                  <th scope="row" className="px-3 text-left font-medium">
                    {t('fromTier', { tier: from })}
                  </th>
                  {TIERS.map((to) => (
                    <td
                      key={to}
                      className={`px-3 text-center tabular-nums ${from === to ? 'font-semibold' : 'text-muted-foreground'}`}
                    >
                      {result.matrix[from][to]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-sm">
            {result.rho === null
              ? t('noCorrelation')
              : t('correlation', {
                  rho: format.number(result.rho, { maximumFractionDigits: 2, minimumFractionDigits: 2 }),
                })}
          </p>
        </div>
      ) : null}
    </div>
  );
}
