'use client';

import type { SiteVersionDiff, SiteVersionSummary } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@bf/ui/components/sheet';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { fetchDiff, fetchVersions } from '../api.ts';
import { DiffView } from './diff-view.tsx';

// The site's history (BF-037): every version with who made it, when, its change summary and its problems; view one
// read-only on the canvas, compare two (BF-035's diff), or restore one (a rollback: a new version, nothing lost).

type Loaded =
  | { readonly state: 'loading' }
  | { readonly state: 'error' }
  | { readonly state: 'ready'; readonly items: readonly SiteVersionSummary[]; readonly next: string | null };

export function VersionsDrawer({
  open,
  onOpenChange,
  siteId,
  currentVersionId,
  canRestore,
  onView,
  onRestore,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly siteId: string;
  /** The version the editor works from (its newest, unless someone saved meanwhile). */
  readonly currentVersionId: string;
  readonly canRestore: boolean;
  readonly onView: (version: SiteVersionSummary) => void;
  readonly onRestore: (version: SiteVersionSummary) => void;
}) {
  const t = useTranslations('siteEditor.versions');
  const format = useFormatter();
  const [loaded, setLoaded] = React.useState<Loaded>({ state: 'loading' });
  const [selected, setSelected] = React.useState<readonly string[]>([]);
  const [diff, setDiff] = React.useState<{
    readonly from: number;
    readonly to: number;
    readonly diff: SiteVersionDiff | 'loading' | 'error';
  } | null>(null);

  const load = React.useCallback(
    async (cursor?: string) => {
      if (!cursor) setLoaded({ state: 'loading' });
      try {
        const page = await fetchVersions(siteId, cursor);
        setLoaded((previous) => ({
          state: 'ready',
          items: cursor && previous.state === 'ready' ? [...previous.items, ...page.items] : page.items,
          next: page.nextCursor ?? null,
        }));
      } catch {
        setLoaded({ state: 'error' });
      }
    },
    [siteId],
  );
  // Read again at each opening (a save or a restore adds versions).
  React.useEffect(() => {
    if (open) {
      setSelected([]);
      void load();
    }
  }, [open, load, currentVersionId]);

  const items = loaded.state === 'ready' ? loaded.items : [];
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((other) => other !== id) : [...current, id].slice(-2),
    );
  const compare = async (ids: readonly string[]) => {
    const versions = ids
      .map((id) => items.find((item) => item.id === id))
      .filter((item): item is SiteVersionSummary => item !== undefined)
      .sort((a, b) => a.versionNumber - b.versionNumber);
    const [older, newer] = versions;
    if (!older || !newer) return;
    setDiff({ from: older.versionNumber, to: newer.versionNumber, diff: 'loading' });
    try {
      const result = await fetchDiff(siteId, older.id, newer.id);
      setDiff({ from: older.versionNumber, to: newer.versionNumber, diff: result });
    } catch {
      setDiff({ from: older.versionNumber, to: newer.versionNumber, diff: 'error' });
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t('title')}</SheetTitle>
            <SheetDescription>{t('description')}</SheetDescription>
          </SheetHeader>
          <div className="flex items-center gap-2 border-b px-4 pb-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={selected.length !== 2}
              onClick={() => void compare(selected)}
            >
              {t('compareSelected')}
            </Button>
            <span className="text-muted-foreground text-xs" aria-live="polite">
              {t('selectedCount', { count: selected.length })}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {loaded.state === 'loading' ? (
              <p className="text-muted-foreground text-sm" role="status">
                {t('loading')}
              </p>
            ) : loaded.state === 'error' ? (
              <div className="flex items-center gap-2 text-sm" role="alert">
                {t('loadFailed')}
                <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
                  {t('retry')}
                </Button>
              </div>
            ) : (
              <ol className="flex flex-col gap-3">
                {items.map((version, index) => {
                  const current = version.id === currentVersionId;
                  const previous = items[index + 1];
                  return (
                    <li key={version.id} className="flex flex-col gap-1 rounded-md border p-3">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={t('select', { version: version.versionNumber })}
                          checked={selected.includes(version.id)}
                          onChange={() => toggle(version.id)}
                        />
                        <span className="text-sm font-semibold">
                          {t('version', { version: version.versionNumber })}
                        </span>
                        {current ? <Badge>{t('current')}</Badge> : null}
                        {version.errors > 0 ? (
                          <Badge variant="destructive">{t('errors', { count: version.errors })}</Badge>
                        ) : null}
                        {version.warnings > 0 ? (
                          <Badge variant="secondary">{t('warnings', { count: version.warnings })}</Badge>
                        ) : null}
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {t(`authors.${version.authorType}`)} ·{' '}
                        <time
                          dateTime={version.createdAt}
                          title={format.dateTime(new Date(version.createdAt), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        >
                          {format.relativeTime(new Date(version.createdAt))}
                        </time>
                      </p>
                      {version.changeSummary ? <p className="text-sm">{version.changeSummary}</p> : null}
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Button type="button" size="sm" variant="outline" onClick={() => onView(version)}>
                          {t('view')}
                        </Button>
                        {previous ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => void compare([previous.id, version.id])}
                          >
                            {t('changes')}
                          </Button>
                        ) : null}
                        {canRestore && !current ? (
                          <Button type="button" size="sm" variant="ghost" onClick={() => onRestore(version)}>
                            {t('restore')}
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
                {loaded.next ? (
                  <li>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void load(loaded.next ?? undefined)}
                    >
                      {t('more')}
                    </Button>
                  </li>
                ) : null}
              </ol>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <Dialog open={diff !== null} onOpenChange={(next) => !next && setDiff(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('diffTitle', { from: diff?.from ?? 0, to: diff?.to ?? 0 })}</DialogTitle>
            <DialogDescription>{t('diffDescription')}</DialogDescription>
          </DialogHeader>
          {diff?.diff === 'loading' ? (
            <p className="text-muted-foreground text-sm" role="status">
              {t('loading')}
            </p>
          ) : diff?.diff === 'error' ? (
            <p className="text-destructive text-sm" role="alert">
              {t('diffFailed')}
            </p>
          ) : diff ? (
            <DiffView diff={diff.diff} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
