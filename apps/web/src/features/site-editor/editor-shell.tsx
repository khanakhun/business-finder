'use client';

// Puck's stylesheet without its external font import (the CSP allows our origin only).
import '@puckeditor/core/no-external.css';
import { ApiError } from '@bf/api-client';
import type { SiteVersion } from '@bf/contracts';
import {
  type BaseOperation,
  type BlockType,
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
import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { getToast } from '@/lib/toast.tsx';
import { applyPuckDataToSpec, itemToBlock } from './adapters/puck-to-ops.ts';
import { type EditorData, specPageToPuckData } from './adapters/spec-to-puck.ts';
import { fetchVersion, saveSite, VersionConflict } from './api.ts';
import { SiteEditorProvider } from './context.tsx';
import { buildPuckConfig, type ConfigLabels } from './puck/build-config.tsx';
import { CanvasFrame } from './puck/canvas.tsx';
import type { FieldSpec } from './puck/field-registry.ts';
import { applyInBatches, whereOf, withPageBlocks } from './state/session.ts';

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

function useConfigLabels(): ConfigLabels {
  const t = useTranslations('siteEditor');
  return React.useMemo(() => {
    const humanize = (key: string) =>
      key
        .replace(/AssetIds?$|Id$/, '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/_/g, ' ')
        .toLowerCase();
    const has = (key: string) => t.has(key as never);
    return {
      block: (type: BlockType) => (has(`blocks.${type}`) ? t(`blocks.${type}` as never) : type),
      variant: (_type: BlockType, variant: string) =>
        has(`variants.${variant}`) ? t(`variants.${variant}` as never) : humanize(variant),
      field: (key: string) => (has(`fieldNames.${key}`) ? t(`fieldNames.${key}` as never) : humanize(key)),
      option: (key: string, option: string) =>
        has(`options.${key}.${option}`) ? t(`options.${key}.${option}` as never) : humanize(option),
      variantField: t('variantField'),
      blocks: t('blocksTitle'),
      yes: t('yes'),
      no: t('no'),
      placeholder: (_field: FieldSpec) => t('newText'),
    };
  }, [t]);
}

/**
 * The visual site editor (BF-037): one page of the site at a time on Puck's canvas, rendered by the block library.
 * Changes stay local until Save (⌘/Ctrl+S), which sends them as BF-033 operations from the version the editor
 * loaded; a concurrent save is a conflict to resolve, never an overwrite. Viewers see the same canvas, read-only.
 *
 * Puck owns the canvas's content once mounted (`data` is its initial state): the editor never pushes data back into a
 * mounted Puck; it remounts it (another page, the latest version after a conflict) or only moves its own base.
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
  // The site with the edits of pages already left (`pending` turns `base.spec` into it), and the page on screen.
  const [working, setWorking] = React.useState<SiteSpec>(base.spec);
  const [pending, setPending] = React.useState<readonly BaseOperation[]>([]);
  const [pageId, setPageId] = React.useState(base.spec.pages[0]?.id ?? '');
  const [locale, setLocale] = React.useState<SiteLocale>(base.spec.defaultLocale);
  // The canvas's latest content (Puck's onChange), and what Puck was mounted with.
  const [data, setData] = React.useState<EditorData>(() => specPageToPuckData(base.spec, pageId));
  const [initial, setInitial] = React.useState<EditorData>(data);
  // Bumped to remount Puck with `initial` (another page, the latest version after a conflict).
  const [mount, setMount] = React.useState(0);
  const [saving, setSaving] = React.useState(false);
  // Set before any await: a second ⌘S while a save is in flight must not send the same base twice.
  const inFlight = React.useRef(false);
  const [conflict, setConflict] = React.useState<VersionConflict | null>(null);
  const [reloading, setReloading] = React.useState(false);

  const config = React.useMemo(() => buildPuckConfig(working, labels), [working, labels]);
  const pageOps = React.useMemo(() => applyPuckDataToSpec(working, pageId, data), [working, pageId, data]);
  const dirty = pending.length > 0 || pageOps.length > 0;
  const dictionary = React.useMemo(() => t.raw('puck' as never) as Dictionary, [t]);

  const remount = (site: SiteSpec, page: string) => {
    const fresh = specPageToPuckData(site, page);
    setPageId(page);
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

  const switchPage = (next: string) => {
    if (next === pageId || inFlight.current) return;
    // The page left keeps its edits (folded into the working site, to be saved with the rest).
    let site = working;
    if (pageOps.length > 0) {
      try {
        site = applyInBatches(working, pageOps);
      } catch (error) {
        void reportRefused(error, withPageBlocks(working, pageId, data.content.map(itemToBlock)));
        return;
      }
      setWorking(site);
      setPending((before) => [...before, ...pageOps]);
    }
    remount(site, next);
  };

  const save = React.useCallback(async () => {
    // Not while a conflict is being resolved (a save from the stale base would only conflict again).
    if (!canEdit || inFlight.current || conflict || reloading) return;
    inFlight.current = true;
    try {
      const toast = await getToast();
      const operations = [...pending, ...pageOps];
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
        setWorking(next.spec);
        setPending([]);
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
  }, [canEdit, conflict, reloading, pending, pageOps, working, pageId, data, base, siteId, t, reportRefused]);

  const reloadLatest = async () => {
    const versionId = conflict?.currentVersionId;
    if (!versionId) {
      setConflict(null);
      return;
    }
    setReloading(true);
    try {
      const next = baseOf(await fetchVersion(siteId, versionId));
      const page = next.spec.pages.some((candidate) => candidate.id === pageId)
        ? pageId
        : (next.spec.pages[0]?.id ?? '');
      setBase(next);
      setWorking(next.spec);
      setPending([]);
      remount(next.spec, page);
      setConflict(null);
    } catch {
      // The dialog stays open: loading can be tried again.
      (await getToast()).error(t('reloadFailed'));
    } finally {
      setReloading(false);
    }
  };

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

  return (
    <SiteEditorProvider value={editorState}>
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
            <Button disabled={reloading} onClick={() => void reloadLatest()}>
              {t('conflictReload')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SiteEditorProvider>
  );
}
