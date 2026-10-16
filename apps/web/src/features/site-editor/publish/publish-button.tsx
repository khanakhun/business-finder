'use client';

import { ApiError } from '@bf/api-client';
import type { SiteDetail } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@bf/ui/components/popover';
import { ExternalLinkIcon, GlobeIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { getToast } from '@/lib/toast.tsx';
import { extendPreview, fetchSite, publishPreview, unpublishPreview } from '../api.ts';

// The preview's state and controls (BF-037): where it is, which version it shows, until when, how many views; publish
// the version the editor saved last (never with errors or unsaved changes), extend it, copy its link, take it down.

const DAYS = [7, 14, 30, 60, 90] as const;

/** Why publishing is not possible now. */
export type PublishBlock = 'unsaved' | 'errors' | null;

export function PublishButton({
  siteId,
  site,
  onSiteChange,
  version,
  canPublish,
  blocked,
}: {
  readonly siteId: string;
  readonly site: SiteDetail;
  readonly onSiteChange: (site: SiteDetail) => void;
  /** The version the editor works from: the one a publish sends. */
  readonly version: { readonly id: string; readonly versionNumber: number };
  readonly canPublish: boolean;
  readonly blocked: PublishBlock;
}) {
  const t = useTranslations('siteEditor.publish');
  const format = useFormatter();
  const [busy, setBusy] = React.useState(false);
  const [days, setDays] = React.useState<number>(30);
  const [confirmingUnpublish, setConfirmingUnpublish] = React.useState(false);
  const preview = site.publications.find(
    (publication) => publication.environment === 'preview' && publication.status === 'active',
  );
  const outdated = preview !== undefined && preview.versionId !== version.id;

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    const toast = await getToast();
    try {
      await action();
      onSiteChange(await fetchSite(siteId));
      toast.success(success);
    } catch (error) {
      const detail = error instanceof ApiError ? (error.problem.detail ?? error.problem.title) : undefined;
      toast.error(detail ? t('failedWith', { reason: detail }) : t('failed'));
    } finally {
      setBusy(false);
      setConfirmingUnpublish(false);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant={preview ? 'outline' : 'default'}>
          <GlobeIcon aria-hidden />
          {preview ? (outdated ? t('buttonOutdated') : t('buttonPublished')) : t('button')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t('title')}</h2>
          {preview ? (
            <Badge variant={outdated ? 'secondary' : 'default'}>{outdated ? t('outdated') : t('live')}</Badge>
          ) : (
            <Badge variant="secondary">{t('notPublished')}</Badge>
          )}
        </div>
        {preview ? (
          <div className="flex flex-col gap-1 text-sm">
            <a
              href={preview.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary flex items-center gap-1 break-all underline"
            >
              {preview.url}
              <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
              <span className="sr-only">{t('opensNewTab')}</span>
            </a>
            <span className="text-muted-foreground text-xs">
              {preview.expiresAt
                ? t('expires', {
                    date: format.dateTime(new Date(preview.expiresAt), { dateStyle: 'medium' }),
                  })
                : t('noExpiry')}
              {' · '}
              {t('views', { count: site.views.last7Days.pageViews })}
            </span>
            {outdated ? (
              <span className="text-xs">{t('outdatedHelp', { version: version.versionNumber })}</span>
            ) : null}
            <div className="flex flex-wrap gap-1 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={async () => {
                  const toast = await getToast();
                  try {
                    await navigator.clipboard.writeText(preview.url);
                    toast.success(t('copied'));
                  } catch {
                    toast.error(t('copyFailed'));
                  }
                }}
              >
                {t('copy')}
              </Button>
              {canPublish ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => extendPreview(siteId, days), t('extended', { days }))}
                  >
                    {t('extend', { days })}
                  </Button>
                  {confirmingUnpublish ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void run(() => unpublishPreview(siteId), t('unpublished'))}
                    >
                      {t('unpublishConfirm')}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirmingUnpublish(true)}
                    >
                      {t('unpublish')}
                    </Button>
                  )}
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">{t('notPublishedHelp')}</p>
        )}
        {canPublish ? (
          <div className="flex flex-col gap-2 border-t pt-3">
            <label className="flex items-center justify-between gap-2 text-sm" htmlFor="publish-days">
              {t('duration')}
              <select
                id="publish-days"
                className="border-input h-8 rounded-md border bg-transparent px-2"
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
              >
                {DAYS.map((value) => (
                  <option key={value} value={value}>
                    {t('days', { days: value })}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              disabled={busy || blocked !== null || (preview !== undefined && !outdated)}
              onClick={() =>
                void run(
                  () => publishPreview(siteId, version.id, days),
                  t('published', { version: version.versionNumber }),
                )
              }
            >
              {t('publishVersion', { version: version.versionNumber })}
            </Button>
            {blocked ? (
              <p className="text-destructive text-xs" role="status">
                {blocked === 'errors' ? t('blockedErrors') : t('blockedUnsaved')}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">{t('noPermission')}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
