'use client';

// Puck's stylesheet without its external font import (the CSP allows our origin only).
import '@puckeditor/core/no-external.css';
import { ApiError } from '@bf/api-client';
import type { SiteVersion } from '@bf/contracts';
import {
  type BaseOperation,
  type Issue,
  OperationError,
  type SiteLocale,
  type SiteSpec,
  SiteSpecSchema,
} from '@bf/site-schema';
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
import { type Data, type Dictionary, Puck } from '@puckeditor/core';
import { ArrowLeftIcon, CircleAlertIcon, FilesIcon, SettingsIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { publicEnv } from '@/lib/public-env.ts';
import { getToast } from '@/lib/toast.tsx';
import { applyPuckDataToSpec, itemToBlock } from './adapters/puck-to-ops.ts';
import { type EditorData, specPageToPuckData } from './adapters/spec-to-puck.ts';
import { fetchVersion, saveSite, VersionConflict } from './api.ts';
import { SiteEditorActionsProvider, SiteEditorProvider } from './context.tsx';
import { useConfigLabels } from './labels.ts';
import { buildPuckConfig } from './puck/build-config.tsx';
import { CanvasFrame } from './puck/canvas.tsx';
import { PagesPanel } from './settings/pages-panel.tsx';
import { SiteSettingsPanel } from './settings/site-settings.tsx';
import { clearDraft, type LocalDraft, readDraft, writeDraft } from './state/local-draft.ts';
import { applyInBatches, canvasSite, whereOf, withPageBlocks } from './state/session.ts';
import {
  change as applyChange,
  type Rebased,
  rebase,
  redo as redoChange,
  type SiteChanges,
  startChanges,
  undo as undoChange,
} from './state/site-changes.ts';
import { IssuesPanel } from './validation/issues-panel.tsx';
import { useValidation } from './validation/use-validation.ts';

/** The version the editor works from: every save is based on it, and replaces it. */
interface Base {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly spec: SiteSpec;
}

const baseOf = (version: SiteVersion): Base => ({
  versionId: version.id,
  versionNumber: version.versionNumber,
  spec: SiteSpecSchema.parse(version.spec),
});

/** Changes that alter the page on screen (its texts, its existence): the canvas is remounted after them. */
const RESHAPING = new Set<BaseOperation['op']>(['setLocales', 'addPage', 'removePage', 'renamePage']);

/** A rebase waiting for the person's word: what replays and what does not. */
interface PendingRebase extends Rebased {
  readonly onto: Base;
  readonly reason: 'conflict' | 'draft';
}

/**
 * The visual site editor (BF-037): one page of the site at a time on Puck's canvas, rendered by the block library,
 * with the site's settings, pages and validation issues in Puck's side panels. Changes stay local until Save
 * (⌘/Ctrl+S), which sends them as BF-033 operations from the version the editor loaded; a concurrent save is a
 * conflict to resolve (replay the changes on the latest version, or load it), never an overwrite. Unsaved work is
 * kept in the browser and offered back after a reload. Viewers see the same editor, read-only.
 *
 * Puck owns the canvas's content once mounted (`data` is its initial state): the editor never pushes data back into a
 * mounted Puck; it remounts it (another page, a reshaping change, the latest version) or only moves its own state.
 */
export function SiteEditor({
  siteId,
  initialVersion,
  canEdit,
}: {
  readonly siteId: string;
  readonly initialVersion: SiteVersion;
  readonly canEdit: boolean;
}) {
  const t = useTranslations('siteEditor');
  const labels = useConfigLabels();
  const [base, setBase] = React.useState<Base>(() => baseOf(initialVersion));
  // The site with the edits of pages already left and the site-level changes (from `base.spec`), with their history.
  const [site, setSite] = React.useState<SiteChanges>(() => startChanges(base.spec));
  const [pageId, setPageId] = React.useState(base.spec.pages[0]?.id ?? '');
  const [locale, setLocale] = React.useState<SiteLocale>(base.spec.defaultLocale);
  // The canvas's latest content (Puck's onChange), and what Puck was mounted with.
  const [data, setData] = React.useState<EditorData>(() => specPageToPuckData(base.spec, pageId));
  const [initial, setInitial] = React.useState<EditorData>(data);
  // Bumped to remount Puck with `initial`.
  const [mount, setMount] = React.useState(0);
  const [saving, setSaving] = React.useState(false);
  // Set before any await: a second ⌘S while a save is in flight must not send the same base twice.
  const inFlight = React.useRef(false);
  const [conflict, setConflict] = React.useState<VersionConflict | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const [pendingRebase, setPendingRebase] = React.useState<PendingRebase | null>(null);
  const [draftOffer, setDraftOffer] = React.useState<LocalDraft | null>(null);

  const working = site.working;
  const config = React.useMemo(() => buildPuckConfig(working, labels), [working, labels]);
  const pageOps = React.useMemo(() => applyPuckDataToSpec(working, pageId, data), [working, pageId, data]);
  const operations = React.useMemo(() => [...site.pending, ...pageOps], [site.pending, pageOps]);
  const dirty = operations.length > 0;
  const dictionary = React.useMemo(() => t.raw('puck' as never) as Dictionary, [t]);
  const assetHosts = React.useMemo(() => [new URL(publicEnv().sitesAssetsUrl).hostname], []);
  const shown = React.useMemo(() => canvasSite(working, pageId, data), [working, pageId, data]);
  const issues = useValidation(shown, assetHosts);

  const remount = (spec: SiteSpec, page: string) => {
    const target = spec.pages.some((candidate) => candidate.id === page) ? page : (spec.pages[0]?.id ?? '');
    const fresh = specPageToPuckData(spec, target);
    setPageId(target);
    setData(fresh);
    setInitial(fresh);
    setMount((n) => n + 1);
  };

  const reportRefused = React.useCallback(
    async (error: unknown, spec: SiteSpec) => {
      const toast = await getToast();
      const detail =
        error instanceof OperationError
          ? error.details[0]
          : error instanceof ApiError
            ? error.problem.errors?.[0]
            : undefined;
      if (!detail) {
        toast.error(
          error instanceof OperationError ? t('refused', { reason: error.message }) : t('saveFailed'),
        );
        return;
      }
      const where = whereOf(spec, detail.path, { block: labels.block, field: labels.field, page: t('page') });
      toast.error(t('refused', { reason: where ? `${where}: ${detail.message}` : detail.message }));
    },
    [t, labels],
  );

  /** The canvas's edits folded into the site (they are saved with the rest); throws when they cannot apply. */
  const folded = (): SiteChanges =>
    pageOps.length === 0
      ? site
      : { ...site, working: applyInBatches(working, pageOps), pending: [...site.pending, ...pageOps] };

  const refusedOnCanvas = (error: unknown) =>
    void reportRefused(error, withPageBlocks(working, pageId, data.content.map(itemToBlock)));

  const switchPage = (next: string) => {
    if (next === pageId || inFlight.current) return;
    try {
      const state = folded();
      setSite(state);
      remount(state.working, next);
    } catch (error) {
      refusedOnCanvas(error);
    }
  };

  /** Runs a site-level change (or its undo/redo) after folding the canvas's edits in. */
  const siteStep = (step: (state: SiteChanges) => SiteChanges, reshapes: boolean, open?: string) => {
    if (!canEdit || inFlight.current) return;
    let state: SiteChanges;
    try {
      state = folded();
    } catch (error) {
      refusedOnCanvas(error);
      return;
    }
    try {
      const next = step(state);
      setSite(next);
      if (reshapes || open) remount(next.working, open ?? pageId);
    } catch (error) {
      void reportRefused(error, state.working);
    }
  };

  const save = React.useCallback(async () => {
    // Not while a conflict is being resolved (a save from the stale base would only conflict again).
    if (!canEdit || inFlight.current || conflict || reloading || pendingRebase) return;
    inFlight.current = true;
    try {
      const toast = await getToast();
      if (operations.length === 0) {
        toast.message(t('noChanges'));
        return;
      }
      let spec: SiteSpec;
      try {
        // Refused here what the API would refuse (an edit that breaks the schema), naming the field.
        spec = applyInBatches(working, pageOps);
      } catch (error) {
        await reportRefused(error, withPageBlocks(working, pageId, data.content.map(itemToBlock)));
        return;
      }
      setSaving(true);
      try {
        const version = await saveSite({ siteId, baseVersionId: base.versionId, operations, spec });
        const next = baseOf(version);
        // Only the base moves: the canvas keeps what is on screen (typing during the save stays, as a new change).
        setBase(next);
        setSite(startChanges(next.spec));
        void clearDraft(siteId);
        const errors = version.issues.filter((issue) => issue.severity === 'error').length;
        if (errors > 0)
          toast.warning(t('savedWithErrors', { version: version.versionNumber, count: errors }));
        else toast.success(t('saved', { version: version.versionNumber }));
      } catch (error) {
        if (error instanceof VersionConflict) setConflict(error);
        else await reportRefused(error, spec);
      } finally {
        setSaving(false);
      }
    } finally {
      inFlight.current = false;
    }
  }, [
    canEdit,
    conflict,
    reloading,
    pendingRebase,
    operations,
    working,
    pageOps,
    pageId,
    data,
    base,
    siteId,
    t,
    reportRefused,
  ]);

  /** Loads the version the conflict named; then either replays the local changes on it, or takes it as it is. */
  const resolveConflict = async (how: 'rebase' | 'discard') => {
    const versionId = conflict?.currentVersionId;
    if (!versionId) {
      setConflict(null);
      return;
    }
    setReloading(true);
    try {
      const latest = baseOf(await fetchVersion(siteId, versionId));
      setConflict(null);
      if (how === 'rebase') {
        setPendingRebase({ ...rebase(latest.spec, operations), onto: latest, reason: 'conflict' });
      } else {
        setBase(latest);
        setSite(startChanges(latest.spec));
        remount(latest.spec, pageId);
        void clearDraft(siteId);
      }
    } catch {
      // The dialog stays open: loading can be tried again.
      (await getToast()).error(t('reloadFailed'));
    } finally {
      setReloading(false);
    }
  };

  /** Takes a rebase: the latest version as the base, the replayed changes as unsaved work. */
  const acceptRebase = () => {
    if (!pendingRebase) return;
    const { onto, applied, spec } = pendingRebase;
    setBase(onto);
    setSite({ working: spec, pending: applied, undo: [], redo: [] });
    remount(spec, pageId);
    setPendingRebase(null);
  };

  const restoreDraft = (draft: LocalDraft) => {
    const replayed = rebase(base.spec, draft.operations);
    setDraftOffer(null);
    if (replayed.failed.length > 0) {
      setPendingRebase({ ...replayed, onto: base, reason: 'draft' });
      return;
    }
    setSite({ working: replayed.spec, pending: replayed.applied, undo: [], redo: [] });
    remount(replayed.spec, draft.pageId);
  };

  // Unsaved work from an earlier visit: offered back (replayed on the version open now).
  React.useEffect(() => {
    if (!canEdit) return;
    void readDraft(siteId).then((draft) => {
      if (draft) setDraftOffer(draft);
    });
  }, [canEdit, siteId]);
  // Unsaved work is kept in the browser a moment after each change (and dropped once saved or discarded).
  React.useEffect(() => {
    if (!canEdit || draftOffer || pendingRebase || operations.length === 0) return;
    const timer = setTimeout(() => {
      void writeDraft({
        siteId,
        baseVersionId: base.versionId,
        baseVersionNumber: base.versionNumber,
        operations,
        pageId,
        savedAt: new Date().toISOString(),
      });
    }, 1_000);
    return () => clearTimeout(timer);
  }, [canEdit, draftOffer, pendingRebase, operations, siteId, base, pageId]);

  // ⌘/Ctrl+S saves; leaving with unsaved edits asks first.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);
  React.useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  // The fields and the canvas read the working site (pages, images, theme): never re-applied on each keystroke.
  const editorState = React.useMemo(
    () => ({ spec: working, pageId, locale, readOnly: !canEdit }),
    [working, pageId, locale, canEdit],
  );
  const actions = {
    change: (op: BaseOperation, options?: { readonly open?: string }) =>
      siteStep((state) => applyChange(state, op), RESHAPING.has(op.op), options?.open),
    undo: () => siteStep(undoChange, site.undo.at(-1)?.inverse.some((op) => RESHAPING.has(op.op)) ?? false),
    redo: () => siteStep(redoChange, RESHAPING.has(site.redo.at(-1)?.op ?? 'setTheme')),
    canUndo: site.undo.length > 0,
    canRedo: site.redo.length > 0,
    openPage: switchPage,
    issues,
    issuesSite: shown,
    showIssue: (issue: Issue) => {
      const page = typeof issue.path[1] === 'number' ? working.pages[issue.path[1]] : undefined;
      if (issue.path[0] === 'pages' && page && page.id !== pageId) switchPage(page.id);
    },
  };
  const errors = issues.filter((issue) => issue.severity === 'error').length;

  return (
    <SiteEditorProvider value={editorState}>
      <SiteEditorActionsProvider value={actions}>
        <div className="flex h-dvh flex-col">
          <header className="flex flex-wrap items-center gap-3 border-b px-3 py-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/sites">
                <ArrowLeftIcon aria-hidden />
                {t('back')}
              </Link>
            </Button>
            <h1 className="truncate text-sm font-semibold">
              {base.spec.brand.name} · {t('version', { version: base.versionNumber })}
            </h1>
            <label className="flex items-center gap-1 text-sm">
              <span className="text-muted-foreground">{t('page')}</span>
              <select
                aria-label={t('page')}
                className="border-input h-8 rounded-md border bg-transparent px-2"
                value={pageId}
                disabled={saving}
                onChange={(event) => switchPage(event.target.value)}
              >
                {working.pages.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.title[locale] ?? page.title[working.defaultLocale] ?? page.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-sm">
              <span className="text-muted-foreground">{t('locale')}</span>
              <select
                aria-label={t('locale')}
                className="border-input h-8 rounded-md border bg-transparent px-2 uppercase"
                value={locale}
                onChange={(event) => setLocale(event.target.value as SiteLocale)}
              >
                {working.locales.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
            <div className="ml-auto flex items-center gap-2">
              {errors > 0 ? (
                <Badge variant="destructive" title={t('issues.blocksPublishing')}>
                  {t('issues.errorCount', { count: errors })}
                </Badge>
              ) : null}
              {canEdit ? (
                <>
                  <span className="text-muted-foreground text-xs" aria-live="polite">
                    {dirty ? t('unsaved') : t('allSaved')}
                  </span>
                  <Button size="sm" onClick={() => void save()} disabled={saving} title={t('shortcutSave')}>
                    {saving ? t('saving') : t('save')}
                  </Button>
                </>
              ) : (
                <Badge variant="secondary" title={t('readOnlyHint')}>
                  {t('readOnly')}
                </Badge>
              )}
            </div>
          </header>
          <div className="min-h-0 flex-1">
            <Puck
              key={`${pageId}:${mount}`}
              config={config}
              data={initial as unknown as Data}
              onChange={(next) => setData(next as unknown as EditorData)}
              iframe={{ enabled: true, syncHostStyles: false }}
              overrides={{ header: () => <></>, iframe: CanvasFrame }}
              dictionary={dictionary}
              plugins={[
                {
                  name: 'site',
                  label: t('panels.site'),
                  icon: <SettingsIcon />,
                  render: () => <SiteSettingsPanel />,
                },
                {
                  name: 'pages',
                  label: t('panels.pages'),
                  icon: <FilesIcon />,
                  render: () => <PagesPanel />,
                },
                {
                  name: 'issues',
                  label: t('panels.issues'),
                  icon: <CircleAlertIcon />,
                  render: () => <IssuesPanel />,
                },
              ]}
              {...(canEdit
                ? {}
                : {
                    permissions: { drag: false, duplicate: false, delete: false, edit: false, insert: false },
                  })}
              viewports={[
                { width: 360, label: t('viewports.mobile'), icon: 'Smartphone' },
                { width: 768, label: t('viewports.tablet'), icon: 'Tablet' },
                { width: 1280, label: t('viewports.desktop'), icon: 'Monitor' },
                { width: '100%', label: t('viewports.full') },
              ]}
              height="100%"
            />
          </div>
        </div>
        <Dialog open={conflict !== null} onOpenChange={(open) => !open && !reloading && setConflict(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('conflictTitle')}</DialogTitle>
              <DialogDescription>{t('conflictBody')}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" disabled={reloading} onClick={() => setConflict(null)}>
                {t('conflictKeep')}
              </Button>
              <Button variant="outline" disabled={reloading} onClick={() => void resolveConflict('discard')}>
                {t('conflictReload')}
              </Button>
              <Button disabled={reloading} onClick={() => void resolveConflict('rebase')}>
                {t('conflictRebase')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={pendingRebase !== null} onOpenChange={(open) => !open && setPendingRebase(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('rebaseTitle')}</DialogTitle>
              <DialogDescription>
                {t('rebaseBody', {
                  applied: pendingRebase?.applied.length ?? 0,
                  failed: pendingRebase?.failed.length ?? 0,
                  version: pendingRebase?.onto.versionNumber ?? 0,
                })}
              </DialogDescription>
            </DialogHeader>
            {pendingRebase && pendingRebase.failed.length > 0 ? (
              <ul className="max-h-48 list-disc overflow-auto pl-5 text-sm" aria-label={t('rebaseFailed')}>
                {pendingRebase.failed.map(({ op, reason }, index) => (
                  <li key={`${op.op}:${index}`}>
                    {t.has(`ops.${op.op}` as never) ? t(`ops.${op.op}` as never) : op.op}
                    <span className="text-muted-foreground" lang="en">
                      {' '}
                      — {reason}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  if (pendingRebase?.reason === 'draft') void clearDraft(siteId);
                  setPendingRebase(null);
                }}
              >
                {t('rebaseDiscard')}
              </Button>
              <Button onClick={acceptRebase}>{t('rebaseAccept')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={draftOffer !== null} onOpenChange={(open) => !open && setDraftOffer(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('draftTitle')}</DialogTitle>
              <DialogDescription>
                {t('draftBody', {
                  count: draftOffer?.operations.length ?? 0,
                  version: draftOffer?.baseVersionNumber ?? 0,
                  when: draftOffer ? new Date(draftOffer.savedAt).toLocaleString() : '',
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setDraftOffer(null);
                  void clearDraft(siteId);
                }}
              >
                {t('draftDiscard')}
              </Button>
              <Button onClick={() => draftOffer && restoreDraft(draftOffer)}>{t('draftRestore')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SiteEditorActionsProvider>
    </SiteEditorProvider>
  );
}
