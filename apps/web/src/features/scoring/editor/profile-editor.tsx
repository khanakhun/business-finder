'use client';

import type { ScoringProfileConfig, ScoringRecomputeProgress } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Label } from '@bf/ui/components/label';
import { Progress } from '@bf/ui/components/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@bf/ui/components/tabs';
import { ArrowLeftIcon, GaugeIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { ConfirmDialog } from '@/components/settings/confirm-dialog.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { REALTIME_EVENTS } from '@/lib/realtime/invalidations.ts';
import { useRealtimeEvent } from '@/lib/realtime/provider.tsx';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import {
  useActivateVersion,
  usePreviewSample,
  useProfileVersion,
  useProfileVersions,
  useSaveVersion,
  useScoringProfiles,
} from '../api.ts';
import { OFFER_ICON } from '../score-badge.tsx';
import { CompareVersions } from './compare.tsx';
import { build, type Draft, toDraft } from './draft.ts';
import { GatesBuilder } from './gates-builder.tsx';
import { useIssueText } from './issue-text.ts';
import { PreviewPanel } from './preview.tsx';
import { ReasonsEditor } from './reasons.tsx';
import { TiersEditor } from './tiers.tsx';
import { TransformsEditor } from './transforms.tsx';
import { WeightsEditor } from './weights.tsx';

// The scoring profile editor (BF-032): a draft started from a saved version, previewed live over a sample of the
// workspace, saved as a new immutable version, then activated (the workspace recomputes, with progress). Built-in
// profiles and members without `scoring:manage` read it only.

type Locale = 'en' | 'fr';

function Editor({
  profileId,
  base,
  baseVersion,
  readOnly,
  locale,
  sample,
  canPreview,
  onSaved,
  onDirtyChange,
}: {
  readonly profileId: string;
  readonly base: ScoringProfileConfig;
  readonly baseVersion: number;
  readonly readOnly: boolean;
  readonly locale: Locale;
  readonly sample: ReturnType<typeof usePreviewSample>['data'];
  readonly canPreview: boolean;
  readonly onSaved: (version: number) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useTranslations('scoringEditor');
  const errorMessage = useErrorMessage();
  const issueText = useIssueText(locale);
  const [draft, setDraft] = React.useState<Draft>(() => toDraft(base));
  const save = useSaveVersion(profileId);
  const { config, issues } = React.useMemo(() => build(draft), [draft]);
  // Edits, not validity: a stored version newer rules refuse is not "changed" until edited.
  const pristine = React.useMemo(() => JSON.stringify(toDraft(base)), [base]);
  const dirty = !readOnly && JSON.stringify(draft) !== pristine;
  React.useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const setConfig = (next: ScoringProfileConfig) => setDraft((current) => ({ ...current, config: next }));
  const sections = [
    {
      id: 'weights',
      node: <WeightsEditor config={draft.config} onChange={setConfig} locale={locale} readOnly={readOnly} />,
    },
    {
      id: 'transforms',
      node: (
        <TransformsEditor config={draft.config} onChange={setConfig} locale={locale} readOnly={readOnly} />
      ),
    },
    {
      id: 'gates',
      node: (
        <GatesBuilder
          gates={draft.gates}
          onChange={(gates) => setDraft((current) => ({ ...current, gates }))}
          locale={locale}
          readOnly={readOnly}
        />
      ),
    },
    { id: 'tiers', node: <TiersEditor config={draft.config} onChange={setConfig} readOnly={readOnly} /> },
    {
      id: 'reasons',
      node: <ReasonsEditor config={draft.config} onChange={setConfig} locale={locale} readOnly={readOnly} />,
    },
  ] as const;
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem] xl:items-start">
      <div className="grid gap-4">
        <Tabs defaultValue="weights">
          <TabsList>
            {sections.map((section) => (
              <TabsTrigger key={section.id} value={section.id}>
                {t(`sections.${section.id}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          {sections.map((section) => (
            <TabsContent key={section.id} value={section.id} className="pt-4">
              {section.node}
            </TabsContent>
          ))}
        </Tabs>
        {issues.length > 0 ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
            data-testid="draft-issues"
          >
            <p className="font-medium">{t('issues')}</p>
            <ul className="mt-1 list-disc pl-5">
              {issues.map((issue) => {
                const { where, what } = issueText(issue);
                return (
                  <li key={`${issue.path.join('.')}:${issue.code}`}>
                    <span className="font-medium">{where}</span>: {what}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {!readOnly ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={!config || !dirty || save.isPending}
              onClick={async () => {
                if (!config) return;
                try {
                  const { version } = await save.mutateAsync(config);
                  (await getToast()).success(t('saved', { version }));
                  onSaved(version);
                } catch (caught) {
                  (await getToast()).error(errorMessage(caught));
                }
              }}
            >
              {t('save')}
            </Button>
            <Button type="button" variant="outline" disabled={!dirty} onClick={() => setDraft(toDraft(base))}>
              {t('reset')}
            </Button>
            <span className="text-sm text-muted-foreground">
              {dirty ? t('draftFrom', { version: baseVersion }) : t('unchanged', { version: baseVersion })}
            </span>
          </div>
        ) : null}
      </div>
      {canPreview ? <PreviewPanel config={config} sample={sample} invalid={config === null} /> : null}
    </div>
  );
}

export function ProfileEditor({ profileId }: { readonly profileId: string }) {
  const t = useTranslations('scoringEditor');
  const offers = useTranslations('scoring.offers');
  const labels = useErrorLabels();
  const errorMessage = useErrorMessage();
  const format = useFormatter();
  const locale = (useLocale() === 'fr' ? 'fr' : 'en') as Locale;
  const canManage = usePermission('scoring:manage');
  const profiles = useScoringProfiles();
  const versions = useProfileVersions(profileId);
  const profile = profiles.data?.items.find((p) => p.id === profileId);
  const [chosen, setChosen] = React.useState<number | null>(null);
  const selected = chosen ?? profile?.activeVersion ?? versions.data?.items[0]?.version ?? null;
  const version = useProfileVersion(profileId, selected);
  const sample = usePreviewSample(profileId, canManage);
  const activate = useActivateVersion(profileId);
  const [progress, setProgressState] = React.useState<ScoringRecomputeProgress | null>(null);
  // Read by the realtime handler (latest value, not the render's).
  const progressRef = React.useRef<ScoringRecomputeProgress | null>(null);
  const setProgress = (next: ScoringRecomputeProgress | null) => {
    progressRef.current = next;
    setProgressState(next);
  };
  const [pendingVersion, setPendingVersion] = React.useState<number | null>(null);
  const dirty = React.useRef(false);
  const onDirtyChange = React.useCallback((next: boolean) => {
    dirty.current = next;
  }, []);

  useRealtimeEvent(REALTIME_EVENTS.scoringRecomputeProgressed, (event) => {
    const payload = event.payload as ScoringRecomputeProgress | null;
    if (payload?.profileId !== profileId) return;
    // While an activation is under way, events of another version (a late one) are ignored.
    const current = progressRef.current;
    if (current && !current.finished && current.version !== payload.version) return;
    // A repeated event (the same run, the same numbers) changes nothing and toasts once.
    if (current && JSON.stringify(current) === JSON.stringify(payload)) return;
    setProgress(payload);
    if (payload.finished)
      void getToast().then((toast) => toast.success(t('recomputed', { count: payload.done })));
  });

  if (profiles.isPending || versions.isPending) return <Skeleton className="h-96 w-full" />;
  const notFound = (versions.error as { status?: number } | null)?.status === 404;
  if (notFound) return <EmptyState icon={<GaugeIcon aria-hidden />} title={t('notFound')} />;
  const failed = profiles.error ?? versions.error;
  if (failed) {
    return (
      <ErrorState
        problem={toProblemLike(failed, t('loadFailed'))}
        labels={labels}
        onRetry={() => {
          void profiles.refetch();
          void versions.refetch();
        }}
      />
    );
  }
  if (!profile) return <EmptyState icon={<GaugeIcon aria-hidden />} title={t('notFound')} />;
  const readOnly = profile.builtin || !canManage || profile.archived;
  const Icon = OFFER_ICON[profile.offer];
  const items = versions.data?.items ?? [];
  const isActive = selected !== null && selected === profile.activeVersion;
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <Link
            href="/settings/scoring"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:underline"
          >
            <ArrowLeftIcon aria-hidden className="size-4" />
            {t('back')}
          </Link>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Icon aria-hidden className="size-5" />
            {profile.name}
            {profile.primary ? <Badge variant="secondary">{t('primary')}</Badge> : null}
            {profile.builtin ? <Badge variant="outline">{t('builtin')}</Badge> : null}
            {profile.archived ? <Badge variant="outline">{t('archived')}</Badge> : null}
          </h2>
          <p className="text-sm text-muted-foreground">{offers(profile.offer)}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <Label htmlFor="profile-version">{t('versionLabel')}</Label>
            <Select
              value={selected === null ? '' : String(selected)}
              onValueChange={(v) => {
                // Another base version starts a new draft: unsaved changes would be lost.
                if (dirty.current) setPendingVersion(Number(v));
                else setChosen(Number(v));
              }}
            >
              <SelectTrigger id="profile-version" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((v) => (
                  <SelectItem key={v.version} value={String(v.version)}>
                    {t(v.active ? 'versionActive' : 'versionSaved', {
                      version: v.version,
                      when: format.dateTime(new Date(v.createdAt), { dateStyle: 'medium' }),
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {canManage && !profile.builtin && !profile.archived && selected !== null ? (
            <Button
              type="button"
              variant={isActive ? 'outline' : 'default'}
              disabled={isActive || activate.isPending}
              onClick={async () => {
                // Pending before the call: a fast recompute's "finished" event may arrive before the response.
                setProgress({ profileId, version: selected, done: 0, total: 0, finished: false });
                try {
                  await activate.mutateAsync(selected);
                  (await getToast()).success(t('activated', { version: selected }));
                } catch (caught) {
                  setProgress(null);
                  (await getToast()).error(errorMessage(caught));
                }
              }}
            >
              {isActive ? t('isActive') : t('activate', { version: selected })}
            </Button>
          ) : null}
        </div>
      </div>
      {progress && !progress.finished ? (
        <div className="grid gap-1" data-testid="recompute-progress">
          <p className="text-sm">
            {t('recomputing', { version: progress.version, done: progress.done, total: progress.total })}
          </p>
          <Progress
            value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0}
            aria-label={t('recomputingLabel')}
          />
        </div>
      ) : null}
      {readOnly ? (
        <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm" role="note">
          {profile.builtin
            ? t('builtinReadOnly')
            : profile.archived
              ? t('archivedReadOnly')
              : t('memberReadOnly')}
        </p>
      ) : null}
      {version.data ? (
        <Editor
          // A new base version starts a new draft.
          key={`${profileId}:${version.data.version}`}
          profileId={profileId}
          base={version.data.config}
          baseVersion={version.data.version}
          readOnly={readOnly}
          locale={locale}
          sample={sample.data}
          canPreview={canManage}
          onDirtyChange={onDirtyChange}
          onSaved={(saved) => setChosen(saved)}
        />
      ) : (
        <Skeleton className="h-96 w-full" />
      )}
      <ConfirmDialog
        open={pendingVersion !== null}
        onOpenChange={(open) => {
          if (!open) setPendingVersion(null);
        }}
        title={t('discardConfirm')}
        confirmLabel={t('reset')}
        onConfirm={async () => {
          if (pendingVersion !== null) setChosen(pendingVersion);
        }}
      />
      {canManage ? (
        <section aria-labelledby="compare-title" className="grid gap-3 rounded-lg border p-4">
          <h2 id="compare-title" className="font-semibold">
            {t('compare.title')}
          </h2>
          <CompareVersions profileId={profileId} versions={items} sample={sample.data} />
        </section>
      ) : null}
    </div>
  );
}
