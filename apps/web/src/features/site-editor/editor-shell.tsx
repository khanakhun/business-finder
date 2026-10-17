'use client';

// Puck's stylesheet without its external font import (the CSP allows our origin only).
import '@puckeditor/core/no-external.css';
import { ApiError } from '@bf/api-client';
import type { SiteDetail, SiteVersion, SiteVersionSummary } from '@bf/contracts';
import {
  type Asset,
  type BaseOperation,
  type Issue,
  type Operation,
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
import {
  ArrowLeftIcon,
  BracesIcon,
  CircleAlertIcon,
  FilesIcon,
  HistoryIcon,
  KeyboardIcon,
  SettingsIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { publicEnv } from '@/lib/public-env.ts';
import { getToast } from '@/lib/toast.tsx';
import { applyPuckDataToSpec, itemToBlock } from './adapters/puck-to-ops.ts';
import { type EditorData, specPageToPuckData } from './adapters/spec-to-puck.ts';
import { fetchVersion, restoreVersion, saveSite, saveSpec, VersionConflict } from './api.ts';
import { SiteEditorActionsProvider, SiteEditorProvider } from './context.tsx';
import { JsonMode } from './json/json-mode.tsx';
import { useConfigLabels } from './labels.ts';
import { PublishButton } from './publish/publish-button.tsx';
import { buildPuckConfig } from './puck/build-config.tsx';
import { CanvasFrame } from './puck/canvas.tsx';
import { PagesPanel } from './settings/pages-panel.tsx';
import { SiteSettingsPanel } from './settings/site-settings.tsx';
import { ShortcutsDialog } from './shortcuts-dialog.tsx';
import { clearDraft, type LocalDraft, readDraft, writeDraft } from './state/local-draft.ts';
import { applyInBatches, canvasSite, whereOf, withPageBlocks } from './state/session.ts';
import {
  change as applyChange,
  flatten,
  type Rebased,
  rebase,
  redo as redoChange,
  type SiteChanges,
  startChanges,
  undo as undoChange,
} from './state/site-changes.ts';
import { IssuesPanel } from './validation/issues-panel.tsx';
import { useValidation } from './validation/use-validation.ts';
import { VersionsDrawer } from './versions/versions-drawer.tsx';

/** The version the editor works from: every save is based on it, and replaces it. */
interface Base {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly spec: SiteSpec;
  /** The errors stored with it (publishing it is refused while there are some). */
  readonly errors: number;
}

const baseOf = (version: SiteVersion): Base => ({
  versionId: version.id,
  versionNumber: version.versionNumber,
  spec: SiteSpecSchema.parse(version.spec),
  errors: version.issues.filter((issue) => issue.severity === 'error').length,
});

/** An earlier version shown read-only on the canvas (from the versions drawer); the edits wait meanwhile. */
interface Viewing {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly spec: SiteSpec;
  readonly pageId: string;
}

type VersionRef = Pick<SiteVersionSummary, 'id' | 'versionNumber'>;

/** A field (or the body) where the person is typing: `?` there is a character, not the shortcuts. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

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
  initialSite,
  initialVersion,
  canEdit,
  canPublish,
  canAdmin,
  userId,
  organizationId,
}: {
  readonly siteId: string;
  readonly initialSite: SiteDetail;
  readonly initialVersion: SiteVersion;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  /** `sites:admin`: the JSON mode. */
  readonly canAdmin: boolean;
  /** Whose drafts these are (a draft is never offered to someone else on the same computer). */
  readonly userId: string;
  readonly organizationId: string;
}) {
  const t = useTranslations('siteEditor');
  const labels = useConfigLabels();
  const owner = React.useMemo(() => ({ userId, organizationId, siteId }), [userId, organizationId, siteId]);
  const [base, setBase] = React.useState<Base>(() => baseOf(initialVersion));
  // The site with the edits of pages already left and the site-level changes (from `base.spec`), with their history.
  const [site, setSiteState] = React.useState<SiteChanges>(() => startChanges(base.spec));
  // `?page=<id>` opens that page (a quality issue's link from the job console, BF-046); the editor is client-only.
  const [pageId, setPageId] = React.useState(() => {
    const asked = new URLSearchParams(window.location.search).get('page');
    return base.spec.pages.find((page) => page.id === asked)?.id ?? base.spec.pages[0]?.id ?? '';
  });
  const [locale, setLocale] = React.useState<SiteLocale>(base.spec.defaultLocale);
  // The canvas's latest content (Puck's onChange), and what Puck was mounted with.
  const [data, setDataState] = React.useState<EditorData>(() => specPageToPuckData(base.spec, pageId));
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
  const [siteDetail, setSiteDetail] = React.useState<SiteDetail>(initialSite);
  const [versionsOpen, setVersionsOpen] = React.useState(false);
  const [viewing, setViewing] = React.useState<Viewing | null>(null);
  const [restoreAsk, setRestoreAsk] = React.useState<VersionRef | null>(null);
  const [restoring, setRestoring] = React.useState(false);
  const [jsonSpec, setJsonSpec] = React.useState<SiteSpec | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  // The latest state, for handlers that run late (a field committing on a pause, a change queued behind a save):
  // they always build on what is current, never on the render that created them.
  const siteRef = React.useRef(site);
  const dataRef = React.useRef(data);
  const pageIdRef = React.useRef(pageId);
  const baseRef = React.useRef(base);
  siteRef.current = site;
  dataRef.current = data;
  pageIdRef.current = pageId;
  baseRef.current = base;
  const setSite = (next: SiteChanges) => {
    siteRef.current = next;
    setSiteState(next);
  };
  const setData = (next: EditorData) => {
    dataRef.current = next;
    setDataState(next);
  };
  // Settings fields with a pending (debounced) value: flushed before any change or save, so nothing typed is lost.
  const flushers = React.useRef(new Set<() => void>());
  const flushing = React.useRef(false);
  const flushFields = () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      for (const flush of flushers.current) flush();
    } finally {
      flushing.current = false;
    }
  };
  // Site changes asked for while a save runs wait for it (they then build on the saved version).
  const queued = React.useRef<(() => void)[]>([]);

  const working = site.working;
  // The canvas shows the site being edited, or an earlier version while one is viewed.
  const canvasSpec = viewing?.spec ?? working;
  const config = React.useMemo(() => buildPuckConfig(canvasSpec, labels), [canvasSpec, labels]);
  const pageOps = React.useMemo(() => applyPuckDataToSpec(working, pageId, data), [working, pageId, data]);
  const operations = React.useMemo(() => [...site.pending, ...pageOps], [site.pending, pageOps]);
  const dirty = operations.length > 0;
  const dictionary = React.useMemo(() => t.raw('puck' as never) as Dictionary, [t]);
  const assetHosts = React.useMemo(() => [new URL(publicEnv().sitesAssetsUrl).hostname], []);
  const shown = React.useMemo(() => canvasSite(working, pageId, data), [working, pageId, data]);
  const issues = useValidation(shown, assetHosts);

  // The language written on the canvas is always one of the site's (removing it falls back to the default).
  React.useEffect(() => {
    if (!working.locales.includes(locale)) setLocale(working.defaultLocale);
  }, [working.locales, working.defaultLocale, locale]);

  const remount = (spec: SiteSpec, page: string) => {
    const target = spec.pages.some((candidate) => candidate.id === page) ? page : (spec.pages[0]?.id ?? '');
    const fresh = specPageToPuckData(spec, target);
    pageIdRef.current = target;
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

  /** The canvas's edits as operations, against the latest working site. */
  const currentPageOps = () =>
    applyPuckDataToSpec(siteRef.current.working, pageIdRef.current, dataRef.current);
  const canvasNamed = () =>
    withPageBlocks(siteRef.current.working, pageIdRef.current, dataRef.current.content.map(itemToBlock));

  /**
   * The canvas's edits folded into the site (they are saved with the rest); throws when they cannot apply. The site's
   * undo history ends there: its inverses point at sections by position, which the canvas's edits may have moved.
   */
  const folded = (): SiteChanges => {
    const current = siteRef.current;
    const ops = currentPageOps();
    if (ops.length === 0) return current;
    return {
      working: applyInBatches(current.working, ops),
      pending: [...current.pending, ...ops],
      undo: [],
      redo: [],
    };
  };

  const switchPage = (next: string) => {
    flushFields();
    if (next === pageIdRef.current || inFlight.current) return;
    try {
      const state = folded();
      setSite(state);
      remount(state.working, next);
    } catch (error) {
      void reportRefused(error, canvasNamed());
    }
  };

  /** Runs a site-level change (or its undo/redo) after folding the canvas's edits in; waits for a running save. */
  const siteStep = (step: (state: SiteChanges) => SiteChanges, reshapes: boolean, open?: string) => {
    if (!canEdit) return;
    if (inFlight.current) {
      queued.current.push(() => siteStep(step, reshapes, open));
      return;
    }
    flushFields();
    let state: SiteChanges;
    try {
      state = folded();
    } catch (error) {
      void reportRefused(error, canvasNamed());
      return;
    }
    try {
      const next = step(state);
      setSite(next);
      if (reshapes || open || state !== siteRef.current) remount(next.working, open ?? pageIdRef.current);
    } catch (error) {
      setSite(state);
      void reportRefused(error, state.working);
    }
  };

  const save = async () => {
    // Not while a conflict is being resolved (a save from the stale base would only conflict again).
    if (!canEdit || inFlight.current || conflict || reloading || pendingRebase) return;
    flushFields();
    inFlight.current = true;
    try {
      const toast = await getToast();
      const sent = siteRef.current;
      const sentPageOps = currentPageOps();
      const operations = [...sent.pending, ...sentPageOps];
      if (operations.length === 0) {
        toast.message(t('noChanges'));
        return;
      }
      let spec: SiteSpec;
      try {
        // Refused here what the API would refuse (an edit that breaks the schema), naming the field.
        spec = applyInBatches(sent.working, sentPageOps);
      } catch (error) {
        await reportRefused(error, canvasNamed());
        return;
      }
      setSaving(true);
      try {
        const version = await saveSite({
          siteId,
          baseVersionId: baseRef.current.versionId,
          operations,
          spec,
        });
        const next = baseOf(version);
        // Only the base moves: the canvas keeps what is on screen (typing during the save stays, as a new change),
        // and the settings' history stays (its inverses hold on the saved site) unless the canvas moved sections.
        baseRef.current = next;
        setBase(next);
        const structural = sentPageOps.some((op) => ['addBlock', 'removeBlock', 'moveBlock'].includes(op.op));
        setSite({
          working: next.spec,
          pending: [],
          undo: structural ? [] : siteRef.current.undo,
          redo: structural ? [] : siteRef.current.redo,
        });
        void clearDraft(owner);
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
      // The changes asked for meanwhile, on the state as it is now.
      for (const run of queued.current.splice(0)) run();
    }
  };
  const saveRef = React.useRef(save);
  saveRef.current = save;

  /** Loads the version the conflict named; then either replays the local changes on it, or takes it as it is. */
  const resolveConflict = async (how: 'rebase' | 'discard') => {
    const versionId = conflict?.currentVersionId;
    if (!versionId) {
      setConflict(null);
      return;
    }
    flushFields();
    setReloading(true);
    try {
      const latest = baseOf(await fetchVersion(siteId, versionId));
      setConflict(null);
      if (how === 'rebase') {
        const ops = [...siteRef.current.pending, ...currentPageOps()];
        setPendingRebase({ ...rebase(latest.spec, ops, base.spec), onto: latest, reason: 'conflict' });
      } else {
        setBase(latest);
        setSite(startChanges(latest.spec));
        remount(latest.spec, pageId);
        void clearDraft(owner);
      }
    } catch {
      // The dialog stays open: loading can be tried again.
      (await getToast()).error(t('reloadFailed'));
    } finally {
      setReloading(false);
    }
  };

  /** Takes a rebase: its version as the base, the replayed changes as unsaved work. */
  const acceptRebase = () => {
    if (!pendingRebase) return;
    const { onto, applied, spec } = pendingRebase;
    setBase(onto);
    setSite({ working: spec, pending: applied, undo: [], redo: [] });
    remount(spec, pageId);
    setPendingRebase(null);
  };

  /**
   * Offers the draft's operations replayed on the version open now, the current edits after them; through the
   * rebase dialog whenever the draft was made on another version or something no longer applies.
   */
  const restoreDraft = (draft: LocalDraft) => {
    setDraftOffer(null);
    const ops = [...draft.operations, ...siteRef.current.pending, ...currentPageOps()];
    const replayed = rebase(base.spec, ops, draft.baseVersionId === base.versionId ? base.spec : undefined);
    if (replayed.failed.length > 0 || draft.baseVersionId !== base.versionId) {
      setPendingRebase({ ...replayed, onto: base, reason: 'draft' });
      return;
    }
    setSite({ working: replayed.spec, pending: replayed.applied, undo: [], redo: [] });
    remount(replayed.spec, draft.pageId);
  };

  /**
   * Adds a picked library image to the site: no remount and no undo step (a field points at it right after), and
   * after a running save (which resets the unsaved changes).
   */
  const addAsset = (asset: Asset) => {
    if (!canEdit) return;
    if (inFlight.current) {
      queued.current.push(() => addAsset(asset));
      return;
    }
    const state = siteRef.current;
    if (state.working.assets.some((existing) => existing.id === asset.id)) return;
    const op: BaseOperation = { op: 'addAsset', asset };
    try {
      setSite({ ...state, working: applyInBatches(state.working, [op]), pending: [...state.pending, op] });
    } catch (error) {
      void reportRefused(error, state.working);
    }
  };

  /** A new base replacing the edits (a restore, a JSON save): the canvas reloads, the draft is dropped. */
  const replaceBase = (version: SiteVersion) => {
    const next = baseOf(version);
    baseRef.current = next;
    setBase(next);
    setSite(startChanges(next.spec));
    remount(next.spec, pageIdRef.current);
    void clearDraft(owner);
  };

  /** Shows an earlier version read-only (the canvas's edits are kept, untouched, until back). */
  const view = async (version: SiteVersionSummary) => {
    flushFields();
    setVersionsOpen(false);
    if (version.id === base.versionId && !dirty) return;
    try {
      const loaded = baseOf(await fetchVersion(siteId, version.id));
      const page = loaded.spec.pages.some((candidate) => candidate.id === pageIdRef.current)
        ? pageIdRef.current
        : (loaded.spec.pages[0]?.id ?? '');
      setViewing({
        versionId: loaded.versionId,
        versionNumber: loaded.versionNumber,
        spec: loaded.spec,
        pageId: page,
      });
    } catch {
      (await getToast()).error(t('versions.viewFailed'));
    }
  };
  const leaveView = () => {
    setViewing(null);
    // Puck comes back with the canvas as it was left.
    setInitial(dataRef.current);
    setMount((n) => n + 1);
  };

  /** Makes an earlier version current again (a new version); unsaved edits are dropped, after a confirmation. */
  const restore = async (version: VersionRef) => {
    if (!canEdit || inFlight.current) return;
    inFlight.current = true;
    setRestoring(true);
    try {
      const restored = await restoreVersion({ siteId, versionId: version.id, baseVersionId: base.versionId });
      setViewing(null);
      setRestoreAsk(null);
      replaceBase(restored);
      (await getToast()).success(
        t('versions.restored', { from: version.versionNumber, version: restored.versionNumber }),
      );
    } catch (error) {
      setRestoreAsk(null);
      if (error instanceof VersionConflict) setConflict(error);
      else await reportRefused(error, base.spec);
    } finally {
      inFlight.current = false;
      setRestoring(false);
      for (const run of queued.current.splice(0)) run();
    }
  };

  /** Saves the JSON mode's document as a new version (the whole spec); true once saved. */
  const saveJson = async (spec: SiteSpec): Promise<boolean> => {
    if (!canAdmin || inFlight.current) return false;
    inFlight.current = true;
    try {
      const version = await saveSpec({
        siteId,
        baseVersionId: baseRef.current.versionId,
        spec,
        changeSummary: t('json.changeSummary'),
      });
      replaceBase(version);
      (await getToast()).success(t('saved', { version: version.versionNumber }));
      return true;
    } catch (error) {
      if (error instanceof VersionConflict) setConflict(error);
      else await reportRefused(error, spec);
      return false;
    } finally {
      inFlight.current = false;
      for (const run of queued.current.splice(0)) run();
    }
  };

  // Unsaved work from an earlier visit (this person's, in this workspace): offered back.
  React.useEffect(() => {
    if (!canEdit) return;
    void readDraft(owner).then((draft) => {
      if (draft) setDraftOffer(draft);
    });
  }, [canEdit, owner]);
  // Unsaved work is kept in the browser a moment after each change, and erased once there is none left.
  React.useEffect(() => {
    if (!canEdit || draftOffer || pendingRebase) return;
    const timer = setTimeout(() => {
      if (operations.length === 0) {
        void clearDraft(owner);
        return;
      }
      void writeDraft({
        ...owner,
        baseVersionId: base.versionId,
        baseVersionNumber: base.versionNumber,
        operations,
        pageId,
        savedAt: new Date().toISOString(),
      });
    }, 1_000);
    return () => clearTimeout(timer);
  }, [canEdit, draftOffer, pendingRebase, operations, owner, base, pageId]);

  // ⌘/Ctrl+S saves; leaving with unsaved edits asks first.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveRef.current();
      } else if (event.key === '?' && !event.metaKey && !event.ctrlKey && !typing(event.target)) {
        event.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  React.useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  // The fields and the canvas read the working site (pages, images, theme): never re-applied on each keystroke.
  const shownPageId = viewing?.pageId ?? pageId;
  const readOnly = !canEdit || viewing !== null;
  const editorState = React.useMemo(
    () => ({ siteId, spec: canvasSpec, pageId: shownPageId, locale, readOnly }),
    [siteId, canvasSpec, shownPageId, locale, readOnly],
  );
  const viewedData = React.useMemo(
    () => (viewing ? specPageToPuckData(viewing.spec, viewing.pageId) : null),
    [viewing],
  );
  const actions = {
    addAsset,
    change: (op: Operation, options?: { readonly open?: string }) =>
      siteStep(
        (state) => applyChange(state, op),
        flatten(op).some((one) => RESHAPING.has(one.op)),
        options?.open,
      ),
    undo: () => siteStep(undoChange, site.undo.at(-1)?.inverse.some((op) => RESHAPING.has(op.op)) ?? false),
    redo: () => siteStep(redoChange, site.redo.at(-1)?.some((op) => RESHAPING.has(op.op)) ?? false),
    canUndo: site.undo.length > 0,
    canRedo: site.redo.length > 0,
    openPage: switchPage,
    register: (flush: () => void) => {
      flushers.current.add(flush);
      return () => {
        flushers.current.delete(flush);
      };
    },
    setLocale,
    issues,
    issuesSite: shown,
    showIssue: (issue: Issue) => {
      const page = typeof issue.path[1] === 'number' ? working.pages[issue.path[1]] : undefined;
      if (issue.path[0] === 'pages' && page && page.id !== pageId) switchPage(page.id);
    },
  };
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const publishBlock = dirty ? 'unsaved' : errors > 0 || base.errors > 0 ? 'errors' : null;

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
                value={shownPageId}
                disabled={saving}
                onChange={(event) =>
                  viewing
                    ? setViewing({ ...viewing, pageId: event.target.value })
                    : switchPage(event.target.value)
                }
              >
                {canvasSpec.pages.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.title[locale] ?? page.title[canvasSpec.defaultLocale] ?? page.id}
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
                {canvasSpec.locales.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('shortcuts.title')}
                title={t('shortcuts.title')}
                onClick={() => setShortcutsOpen(true)}
              >
                <KeyboardIcon aria-hidden />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setVersionsOpen(true)}>
                <HistoryIcon aria-hidden />
                {t('versions.button')}
              </Button>
              {canAdmin ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={viewing !== null}
                  onClick={() => {
                    flushFields();
                    setJsonSpec(canvasSite(siteRef.current.working, pageIdRef.current, dataRef.current));
                  }}
                >
                  <BracesIcon aria-hidden />
                  {t('json.button')}
                </Button>
              ) : null}
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
                  <Button
                    size="sm"
                    onClick={() => void saveRef.current()}
                    disabled={saving}
                    title={t('shortcutSave')}
                  >
                    {saving ? t('saving') : t('save')}
                  </Button>
                </>
              ) : (
                <Badge variant="secondary" title={t('readOnlyHint')}>
                  {t('readOnly')}
                </Badge>
              )}
              <PublishButton
                siteId={siteId}
                site={siteDetail}
                onSiteChange={setSiteDetail}
                version={{ id: base.versionId, versionNumber: base.versionNumber }}
                canPublish={canPublish}
                blocked={publishBlock}
              />
            </div>
          </header>
          {viewing ? (
            <div
              className="flex flex-wrap items-center gap-2 border-b bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50"
              role="status"
            >
              <span className="font-medium">{t('versions.viewing', { version: viewing.versionNumber })}</span>
              <Button size="sm" variant="outline" onClick={leaveView}>
                {t('versions.backToEditing')}
              </Button>
              {canEdit && viewing.versionId !== base.versionId ? (
                <Button
                  size="sm"
                  onClick={() =>
                    setRestoreAsk({ id: viewing.versionId, versionNumber: viewing.versionNumber })
                  }
                >
                  {t('versions.restoreThis')}
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <Puck
              key={viewing ? `view:${viewing.versionId}:${viewing.pageId}` : `${pageId}:${mount}`}
              config={config}
              data={(viewedData ?? initial) as unknown as Data}
              onChange={(next) => {
                // A viewed version is read-only: Puck's own updates of it are not edits.
                if (!viewing) setData(next as unknown as EditorData);
              }}
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
              {...(!readOnly
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
                  if (pendingRebase?.reason === 'draft') void clearDraft(owner);
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
                  void clearDraft(owner);
                }}
              >
                {t('draftDiscard')}
              </Button>
              <Button onClick={() => draftOffer && restoreDraft(draftOffer)}>{t('draftRestore')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <VersionsDrawer
          open={versionsOpen}
          onOpenChange={setVersionsOpen}
          siteId={siteId}
          currentVersionId={base.versionId}
          canRestore={canEdit}
          onView={(version) => void view(version)}
          onRestore={(version) => {
            setVersionsOpen(false);
            setRestoreAsk(version);
          }}
        />
        <Dialog
          open={restoreAsk !== null}
          onOpenChange={(open) => !open && !restoring && setRestoreAsk(null)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t('versions.restoreTitle', { version: restoreAsk?.versionNumber ?? 0 })}
              </DialogTitle>
              <DialogDescription>
                {dirty ? t('versions.restoreBodyUnsaved') : t('versions.restoreBody')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" disabled={restoring} onClick={() => setRestoreAsk(null)}>
                {t('versions.cancel')}
              </Button>
              <Button disabled={restoring} onClick={() => restoreAsk && void restore(restoreAsk)}>
                {restoring ? t('versions.restoring') : t('versions.restore')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {jsonSpec ? (
          <JsonMode
            open
            onOpenChange={(open) => !open && setJsonSpec(null)}
            spec={jsonSpec}
            assetHosts={assetHosts}
            onSave={saveJson}
          />
        ) : null}
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </SiteEditorActionsProvider>
    </SiteEditorProvider>
  );
}
